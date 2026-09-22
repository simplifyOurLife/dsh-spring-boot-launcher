// Smoke: profiles collection + /inspect endpoint + start-with-profile flow.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const FIX = join(process.env.TEMP, "dsh-bl-fixture-prof");
const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
rmSync(FIX, { recursive: true, force: true });
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

const dir = FIX;
mkdirSync(join(dir, "src", "main", "resources", "config"), { recursive: true });
mkdirSync(join(dir, "src", "main", "java", "demo"), { recursive: true });
writeFileSync(join(dir, "pom.xml"), `<project>
  <parent><groupId>g</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <artifactId>appmod</artifactId><version>1.0</version>
</project>`);
writeFileSync(join(dir, "src", "main", "java", "demo", "App.java"),
  "package demo;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
// profiles in src config/ (like the real projects) + a built copy in target
for (const p of ["TestB34", "TestA12", "dev"]) {
  writeFileSync(join(dir, "src", "main", "resources", "config", `application-${p}.yml`), "server:\n  port: 9100\n");
}
writeFileSync(join(dir, "src", "main", "resources", "config", "application.yml"),
  "server:\n  port: 9100\nspring:\n  profiles:\n    active: TestB34\n");
mkdirSync(join(dir, "target", "classes", "config"), { recursive: true });
writeFileSync(join(dir, "target", "classes", "config", "ignored-note.yml"), "x"); // not application-*.yml → ignored
writeFileSync(join(dir, "target", "classes", "config", "application-prod.yml"), "x");     // target-only profile → still found

const registered = [];
const captured = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: (s) => {
      captured.push(s);
      return {
        status: "running", pid: 321, exitCode: undefined,
        readOutput: () => ({ delta: "Started App\n", lossy: false }),
        kill() { return true; }, done: Promise.resolve(),
      };
    },
  },
  on: () => () => {},
};
const plugin = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href);
plugin.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

// 1. inspect exposes the profiles list (src ∪ target, sorted, deduped)
const insp = await byName.spring_boot_inspect.execute({ dir }, {});
assert.ok(insp.matched, "inspect matches");
assert.deepStrictEqual(insp.profiles, ["TestA12", "TestB34", "dev", "prod"], "profiles collected: " + JSON.stringify(insp.profiles));
assert.strictEqual(insp.activeProfile, "TestB34", "active profile read from config/application.yml");
JSON.stringify(insp); // lossless
console.log("✓ inspect profiles:", JSON.stringify(insp.profiles), "| active:", insp.activeProfile);

// 2. start with explicit profile passes it through to the command
const h = await byName.spring_boot_start.execute({ dir, mode: "direct-classpath", profile: "TestA12", detach: true }, { signal: { aborted: true } });
assert.ok(!h.isError, "start ok: " + JSON.stringify(h.error || null));
const cmd = captured.at(-1).command;
assert.ok(cmd.includes("-Dspring.profiles.active=TestA12"), "profile in launch cmd: " + cmd);
console.log("✓ start with profile=TestA12 →", cmd.slice(cmd.indexOf("-Dspring"), cmd.indexOf("-Dspring") + 40));

// 3. /inspect HTTP endpoint (bind a private port away from the live DSH
// instance on 17890, which runs the older in-process code)
const { createWebHost } = await import('./support/web-host.mjs');
const host = await createWebHost();
const plugin2 = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href + "?t=" + Date.now());
{
  const registered2 = [];
  const ctx2 = { tools: { register: (t) => registered2.push(t) }, shell: { resolve: (s) => s, run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }, on: () => () => {} };
  Object.assign(ctx2, host);
  plugin2.apply(ctx2);
}
const port = 17980;
await new Promise((r) => setTimeout(r, 800));
const res = await host.fetch(`/inspect?dir=${encodeURIComponent(FIX)}`);
const j = await res.json();
assert.strictEqual(j.matched, true, "endpoint matched");
assert.deepStrictEqual(j.profiles, ["TestA12", "TestB34", "dev", "prod"], "endpoint profiles");
assert.strictEqual(j.defaultProfile, "TestB34", "endpoint defaultProfile = active");
console.log("✓ /inspect endpoint:", JSON.stringify({ matched: j.matched, profiles: j.profiles.length, defaultProfile: j.defaultProfile }));

// 4. /inspect with bad dir
const res2 = await host.fetch(`/inspect?dir=${encodeURIComponent(join(FIX, "nope"))}`);
const j2 = await res2.json();
assert.strictEqual(j2.matched, false, "bad dir not matched");
console.log("✓ /inspect bad dir →", JSON.stringify(j2));

rmSync(FIX, { recursive: true, force: true });
console.log("\nPROFILES SMOKE TESTS PASSED");
host.close();
process.exit(0);
