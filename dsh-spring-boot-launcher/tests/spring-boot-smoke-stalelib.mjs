// Smoke: stale-lib degrade — a direct-classpath launch that dies with
// NoClassDefFoundError and has a reactor root must retry ONCE via
// dev-run-classpath (reactor prepare rebuilds the deps). A death WITHOUT
// the missing-class signature must NOT degrade (fast failure stays honest).
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "assert";

process.env.DSH_REBUILD_WAIT_MS = "3000"; // keep the rebuild health wait short in tests
const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

const FIX = join(process.env.TEMP, "dsh-spring-boot-fixture-stalelib");
rmSync(FIX, { recursive: true, force: true });

// reactor root → svc (spring app) + libmod (plain lib, no main)
mkdirSync(FIX, { recursive: true });
writeFileSync(join(FIX, "pom.xml"),
  "<project><groupId>g</groupId><artifactId>root</artifactId><modules><module>svc</module></modules></project>");
const svc = join(FIX, "svc");
mkdirSync(join(svc, "src", "main", "java", "a"), { recursive: true });
mkdirSync(join(svc, "target", "classes"), { recursive: true });
mkdirSync(join(svc, "target", "lib"), { recursive: true });
writeFileSync(join(svc, "pom.xml"),
  "<project><groupId>g</groupId><artifactId>svc</artifactId>" +
  "<build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId>" +
  "<configuration><includes><include>nothing:nothing</include></includes></configuration></plugin></plugins></build></project>");
writeFileSync(join(svc, "src", "main", "java", "a", "App.java"),
  "package a;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
writeFileSync(join(svc, "target", "classes", "App.class"), "x");
writeFileSync(join(svc, "target", "lib", "stale-dep.jar"), "old copy, missing new deps");
const t = new Date(Date.now() + 3000);
utimesSync(join(svc, "target", "classes", "App.class"), t, t);

const registered = [];
const launches = [];
let exits = 0;
function fakeProc() {
  // first launch: dies with NoClassDefFoundError (the stale-lib signature)
  // second (rebuilt) launch: stays running
  exits++;
  return {
    status: exits === 1 ? "completed" : "running",
    pid: 1000 + exits,
    exitCode: exits === 1 ? 1 : undefined,
    _buf: exits === 1 ? "java.lang.NoClassDefFoundError: redis/clients/jedis/JedisPoolConfig\n" : "",
    readOutput() { const d = this._buf; this._buf = ""; return { delta: d, lossy: false }; },
    kill() { return true; },
    done: Promise.resolve(),
  };
}
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: (spec) => { launches.push(spec.command); return fakeProc(); },
  },
  on: () => () => {},
};
const p = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))) + "?stale" + Date.now());
p.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

// 1. inspect confirms the workspace facts
const insp = await byName.spring_boot_inspect.execute({ dir: svc }, {});
assert.ok(insp.reactorRoot && insp.reactorRoot.endsWith("dsh-spring-boot-fixture-stalelib"), "reactor root found");

// 2. auto start: dies on missing class → degrade to reactor rebuild → 2nd proc runs
const h = await byName.spring_boot_start.execute({ dir: svc, detach: true }, { signal: {} });
assert.ok(!h.isError, "start ok after degrade: " + JSON.stringify(h.error || null));
assert.strictEqual(launches.length, 2, "exactly two launches (stale attempt + rebuilt retry)");
// The retry is a dev-run-classpath rebuild: plain (module-dir mvn) when the
// module has no internal deps, reactor (-f root -pl) when it does.
assert.ok(launches[1].includes("mvn") && launches[1].includes("copy-dependencies"),
  "retry rebuilds deps via mvn copy-dependencies: " + launches[1].slice(0, 100));
assert.ok((h.mode || "").includes("rebuilt"), "mode reports the rebuild: " + h.mode);
console.log("✓ stale-lib degrade: attempt →", launches[0].slice(0, 70) + "…");
console.log("  rebuilt →", launches[1].slice(0, 90) + "…");

// 3. a death WITHOUT the missing-class signature must NOT degrade
launches.length = 0;
const ctx2 = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: (spec) => {
      launches.push(spec.command);
      return {
        status: "completed", pid: 7, exitCode: 1,
        _buf: "SomeOtherError: port already in use\n",
        readOutput() { const d = this._buf; this._buf = ""; return { delta: d, lossy: false }; },
        kill() { return true; }, done: Promise.resolve(),
      };
    },
  },
  on: () => () => {},
};
const p2 = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))) + "?stale2" + Date.now());
p2.apply(ctx2);
const byName2 = registered.filter((t, i) => i >= registered.length).length; // noop
const reg2 = [];
ctx2.tools = { register: (t) => reg2.push(t) };
const p3 = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))) + "?stale3" + Date.now());
p3.apply(ctx2);
const byName3 = Object.fromEntries(reg2.map((t) => [t.name, t]));
const h2 = await byName3.spring_boot_start.execute({ dir: svc, detach: true }, { signal: {} });
assert.ok(h2.isError, "non-missing-class death reports PROCESS_EXITED_EARLY, no degrade");
assert.strictEqual(h2.error.code, "PROCESS_EXITED_EARLY", "honest failure code");
assert.strictEqual(launches.length, 1, "no second launch for unrelated deaths");
console.log("✓ unrelated deaths stay honest (no degrade): " + h2.error.code);

rmSync(FIX, { recursive: true, force: true });
console.log("\nSTALE-LIB DEGRADE TESTS PASSED");
process.exit(0);
