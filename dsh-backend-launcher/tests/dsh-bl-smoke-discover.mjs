// 使用独立临时夹具验证工作区发现，不依赖业务工程。
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";
import { createWebHost } from './support/web-host.mjs';

const registered = [];
const host = await createWebHost();
const ctx = {
  ...host,
  tools: { register: (t) => registered.push(t) },
  shell: { resolve: (s) => s, run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
  on: () => () => {},
};
const plugin = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href + "?disc");
plugin.apply(ctx);
await new Promise((r) => setTimeout(r, 600));

// 2. Fixture: workspace root with an independent single project + a multi-module parent
const FIX = mkdtempSync(join(tmpdir(), "dsh-bl-fixture-ws-"));
// single project
mkdirSync(join(FIX, "solo", "src", "main", "java", "demo"), { recursive: true });
writeFileSync(join(FIX, "solo", "pom.xml"), "<project><artifactId>solo</artifactId></project>");
writeFileSync(join(FIX, "solo", "src", "main", "java", "demo", "App.java"),
  "package demo;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
// multi-module parent with one runnable child (main class) + one library child
mkdirSync(join(FIX, "multi", "app", "src", "main", "java", "x"), { recursive: true });
mkdirSync(join(FIX, "multi", "lib"), { recursive: true });
writeFileSync(join(FIX, "multi", "pom.xml"), "<project><modules><module>app</module><module>lib</module><module>nest</module></modules></project>");
writeFileSync(join(FIX, "multi", "app", "pom.xml"), "<project><artifactId>app</artifactId></project>");
writeFileSync(join(FIX, "multi", "app", "src", "main", "java", "x", "Main.java"),
  "package x;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class Main {\n  public static void main(String[] a) {}\n}\n");
writeFileSync(join(FIX, "multi", "lib", "pom.xml"), "<project><artifactId>lib</artifactId></project>");
// NESTED parent (example-parent shape): leaf module hides one level deeper
mkdirSync(join(FIX, "multi", "nest", "leaf", "src", "main", "java", "y"), { recursive: true });
writeFileSync(join(FIX, "multi", "nest", "pom.xml"), "<project><modules><module>leaf</module></modules></project>");
writeFileSync(join(FIX, "multi", "nest", "leaf", "pom.xml"), "<project><artifactId>leaf</artifactId></project>");
writeFileSync(join(FIX, "multi", "nest", "leaf", "src", "main", "java", "y", "Leaf.java"),
  "package y;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class Leaf {\n  public static void main(String[] a) {}\n}\n");
// noise dir without pom
mkdirSync(join(FIX, "notmaven"), { recursive: true });
writeFileSync(join(FIX, "notmaven", "readme.txt"), "x");
// LIBRARY module: compiled (target/classes exists — IDEA builds it) but NO
// main entry. Must NOT appear in discovery even though artifacts exist.
mkdirSync(join(FIX, "multi", "libmod", "target", "classes"), { recursive: true });
writeFileSync(join(FIX, "multi", "libmod", "pom.xml"), "<project><artifactId>libmod</artifactId></project>");
writeFileSync(join(FIX, "multi", "libmod", "target", "classes", "Lib.class"), "x");
// add libmod to multi's modules so the expansion walks it
writeFileSync(join(FIX, "multi", "pom.xml"), "<project><modules><module>app</module><module>lib</module><module>nest</module><module>libmod</module></modules></project>");

const res2 = await (await host.fetch(`/discover?dir=${encodeURIComponent(FIX)}`)).json();
const names = res2.projects.map((p) => p.name).sort();
console.log("fixture:", JSON.stringify(names));
assert.deepStrictEqual(names, ["multi/app", "multi/nest/leaf", "solo"], "discover finds services only; skips library modules (compiled but no main), lib & noise");
assert.ok(!names.includes("multi/libmod"), "LIBRARY module with build artifacts but no main must NOT be startable");
const multiEntry = res2.projects.find((p) => p.name === "multi/app");
assert.strictEqual(multiEntry.isModule, true, "module flagged");

// 3. empty root
const res3 = await (await host.fetch(`/discover?dir=${encodeURIComponent(join(FIX, "notmaven"))}`)).json();
assert.deepStrictEqual(res3.projects, [], "no Spring Boot services in non-maven dir");

rmSync(FIX, { recursive: true, force: true });
console.log("\nDISCOVER SMOKE TESTS PASSED");
host.close();
process.exit(0);
