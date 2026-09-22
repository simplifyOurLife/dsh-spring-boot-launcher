// Extra smoke tests (Sep 1): direct-classpath sibling resolution, staleness
// fields, fully-qualified annotation matching, stale internal-jar pruning.
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const FIX = join(process.env.TEMP, "dsh-bl-fixture2");
const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
rmSync(FIX, { recursive: true, force: true });
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

const BS = String.fromCharCode(92); // backslash, kept out of source literals
const cpA = ["mod-a", "target", "classes"].join(BS);
const cpB = ["mod-b", "target", "classes"].join(BS);
const ownClasses = ["target", "classes"].join(BS);
const ownLib = ["target", "lib", "*"].join(BS);
const ownConfig = ["target", "config"].join(BS);
const sibA = ["..", "mod-a", "target", "classes"].join(BS);

// multi-module parent with two children; only mod-b has the app + artifacts
const parent = FIX, childA = join(FIX, "mod-a"), childB = join(FIX, "mod-b");
for (const d of [childA, childB]) mkdirSync(join(d, "src", "main", "java", "demo"), { recursive: true });
writeFileSync(join(parent, "pom.xml"), `<project>
  <parent><groupId>g</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <artifactId>parent</artifactId><version>1.0</version>
  <modules><module>mod-a</module><module>mod-b</module></modules>
</project>`);
writeFileSync(join(childA, "pom.xml"),
  "<project><groupId>demo</groupId><artifactId>mod-a</artifactId></project>");
// mod-b DECLARES a dependency on sibling mod-a — the workspace-resolution
// rule mounts exactly the DECLARED siblings, so the pom must say it.
writeFileSync(join(childB, "pom.xml"),
  "<project><groupId>demo</groupId><artifactId>mod-b</artifactId>" +
  "<dependencies><dependency><groupId>demo</groupId><artifactId>mod-a</artifactId></dependency></dependencies>" +
  "</project>");
// fully-qualified annotation on purpose: exercises the regex hardening
writeFileSync(join(childB, "src", "main", "java", "demo", "App.java"),
  "package demo;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App { public static void main(String[] a) {} }");
mkdirSync(join(childA, "target", "classes"), { recursive: true });
mkdirSync(join(childB, "target", "classes"), { recursive: true });
mkdirSync(join(childB, "target", "lib"), { recursive: true });
writeFileSync(join(childB, "target", "lib", "dep1.jar"), "third-party");
// STALE internal jar: mod-a-1.0.jar in mod-b's lib, older than mod-a's src.
writeFileSync(join(childB, "target", "lib", "mod-a-1.0.jar"), "stale internal");
// make mod-a's source NEWER than that jar (jar predates the source edit)
const later = new Date(Date.now() + 5000);
writeFileSync(join(childA, "src", "main", "java", "demo", "Old.java"),
  "package demo;\n// newer than the stale jar\npublic class Old {}\n");
utimesSync(join(childA, "src", "main", "java", "demo", "Old.java"), later, later);
mkdirSync(join(childB, "target", "config"), { recursive: true });

const registered = [];
const startSpecs = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: (s) => {
      startSpecs.push(s);
      return {
        status: "running", pid: 7, exitCode: undefined,
        readOutput: () => ({ delta: "Started App in 1s\n", lossy: false }),
        kill() { return true; }, done: Promise.resolve(),
      };
    },
  },
  on: () => () => {},
};
const plugin = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href);
plugin.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
const execAbort = { signal: { aborted: true } };

// 1. inspect on the parent: mainClass from child (fully-qualified annotation)
const insp = await byName.spring_boot_inspect.execute({ dir: parent }, {});
assert.strictEqual(insp.mainClass, "demo.App", "mainClass via child scan");
assert.strictEqual(insp.thinJarStale, false, "no jar → stale false");
assert.ok("targetClassesStale" in insp, "staleness fields present");
JSON.stringify(insp);
console.log("✓ inspect multi-module parent:", JSON.stringify({ mainClass: insp.mainClass, thinJarStale: insp.thinJarStale }));

// 2a. direct-classpath from the PARENT
const h = await byName.spring_boot_start.execute({ dir: parent, mode: "direct-classpath", detach: true }, execAbort);
assert.ok(!h.isError, "parent start must not error: " + JSON.stringify(h.error || null));
const inner = h.cmd;
assert.ok(inner.includes("-cp"), "classpath built");
assert.ok(inner.includes(cpA), "sibling mod-a classes on cp: " + inner);
assert.ok(inner.includes(cpB), "own mod-b classes on cp");
assert.ok(inner.indexOf(cpA) < inner.indexOf(cpB), "sibling precedes own (shadowing order)");
assert.ok(inner.split(cpB).length - 1 === 1, "no duplicate own classes");
assert.ok(inner.length < 4000, "command stays short");
assert.ok(h.modeReasons.some((r) => r.includes("sibling")), "sibling note: " + JSON.stringify(h.modeReasons));
console.log("✓ direct-classpath from parent:", inner.slice(inner.indexOf("-cp"), inner.indexOf("-cp") + 110) + "…");

// 2b. direct-classpath from the CHILD (parent-pom sibling probe) — this is
// the path that also prunes the stale mod-a jar from mod-b's lib.
const h2 = await byName.spring_boot_start.execute({ dir: childB, mode: "direct-classpath", detach: true }, execAbort);
assert.ok(!h2.isError, "child start must not error: " + JSON.stringify(h2.error || null));
const inner2 = h2.cmd;
assert.ok(inner2.includes(sibA), "sibling ../mod-a on cp: " + inner2);
assert.ok(inner2.indexOf(sibA) < inner2.indexOf(ownClasses), "sibling ahead of own classes");
assert.ok(inner2.includes(ownLib), "own lib wildcard");
assert.ok(inner2.includes(ownConfig), "own config dir");

// 3. stale internal jar pruned from childB/target/lib; third-party kept
assert.ok(!existsSync(join(childB, "target", "lib", "mod-a-1.0.jar")), "stale mod-a jar pruned");
assert.ok(existsSync(join(childB, "target", "lib", "dep1.jar")), "third-party jar kept");
assert.ok(h2.modeReasons.some((r) => r.includes("pruned stale internal jar")), "prune note: " + JSON.stringify(h2.modeReasons));
console.log("✓ stale internal jar pruned, third-party jar untouched");

// 4. sandbox policy still stamped on all starts
assert.ok(startSpecs.every((s) => s.sandboxPolicy && s.sandboxPolicy.mode === "danger-full-access"), "policy on all starts");

// cleanup
rmSync(FIX, { recursive: true, force: true });
console.log("\nEXTRA SMOKE TESTS PASSED");
process.exit(0);
