// Smoke: workspace resolution for internal deps missing from ~/.m2
// (the service-api failure: bare mvn can't resolve sibling deps).
// Fixture mimics example-parent: root → service-parent(nested) → app,
// app declares dep on top-level common; common NOT in ~/.m2.
// Expect: (a) inspect reports the internal dep + missing-in-m2;
// (b) auto mode routes to direct-classpath with ONLY the declared dep's
// classes (not other service apps — bean-conflict trap) + app classes +
// src resources (partial-config-gap trap) + assembly lib location.
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

// Point HOME-like resolution AWAY from the real ~/.m2 so "missing" is real.
// (internalDepsMissingInM2 probes <USERPROFILE>/.m2/repository — the real one
// never contains the fixture artifactIds, so no override needed.)

const ROOT = join(process.env.TEMP, "dsh-spring-boot-fixture-wsres");
rmSync(ROOT, { recursive: true, force: true });

// root pom (example-parent shape)
mkdirSync(ROOT, { recursive: true });
writeFileSync(join(ROOT, "pom.xml"),
  "<project><groupId>g</groupId><artifactId>root</artifactId><modules><module>common</module><module>common2</module><module>service-parent</module></modules></project>");
// common (top-level library module, IDEA-compiled) — depends on common2,
// making common2 a TRANSITIVE internal dep of the app (MDEP-187 case)
mkdirSync(join(ROOT, "common", "src", "main", "java", "c"), { recursive: true });
writeFileSync(join(ROOT, "common", "pom.xml"),
  "<project><groupId>g</groupId><artifactId>common</artifactId>" +
  "<dependencies><dependency><groupId>g</groupId><artifactId>common2</artifactId></dependency></dependencies></project>");
mkdirSync(join(ROOT, "common", "target", "classes"), { recursive: true });
writeFileSync(join(ROOT, "common", "target", "classes", "C.class"), "x");
// common2: transitive lib, NO classes (must still be excluded from copy-deps)
mkdirSync(join(ROOT, "common2", "src", "main", "java", "c2"), { recursive: true });
writeFileSync(join(ROOT, "common2", "pom.xml"), "<project><groupId>g</groupId><artifactId>common2</artifactId></project>");
// service-parent (nested parent)
mkdirSync(join(ROOT, "service-parent"), { recursive: true });
writeFileSync(join(ROOT, "service-parent", "pom.xml"),
  "<project><groupId>g</groupId><artifactId>service-parent</artifactId><modules><module>app</module><module>sibling-app</module></modules></project>");
function mkApp(slug, declCommon) {
  const d = join(ROOT, "service-parent", slug);
  mkdirSync(join(d, "src", "main", "java", "a"), { recursive: true });
  mkdirSync(join(d, "src", "main", "resources", "config"), { recursive: true });
  mkdirSync(join(d, "target", "classes", "config"), { recursive: true });
  writeFileSync(join(d, "pom.xml"), `<project><groupId>g</groupId><artifactId>${slug}</artifactId>
  <dependencies>${declCommon ? "<dependency><groupId>g</groupId><artifactId>common</artifactId></dependency>" : ""}</dependencies>
</project>`);
  writeFileSync(join(d, "src", "main", "java", "a", "App.java"),
    "package a;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
  // full config in src, PARTIAL copy in target/classes (the dev-hb trap)
  writeFileSync(join(d, "src", "main", "resources", "config", "application-missing.yml"), "x");
  writeFileSync(join(d, "src", "main", "resources", "config", "application.yml"), "x");
  writeFileSync(join(d, "target", "classes", "config", "application.yml"), "x"); // only this one copied
  writeFileSync(join(d, "target", "classes", "App.class"), "x");
  // assembly-style third-party jar dir (target/<assembly>/lib)
  mkdirSync(join(d, "target", "assem", "lib"), { recursive: true });
  writeFileSync(join(d, "target", "assem", "lib", "spring-boot-starter-tomcat-2.7.18.jar"), "x");
  writeFileSync(join(d, "target", "assem", "lib", "some-dep.jar"), "x");
  return d;
}
const appDir = mkApp("app", true);       // declares dep on common
mkApp("sibling-app", false);             // co-resident app — must NOT mount
// make classes fresh
const t = new Date(Date.now() + 3000);
utimesSync(join(appDir, "target", "classes", "App.class"), t, t);

const registered = [];
const captured = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: (spec) => {
      captured.push(spec);
      const proc = {
        status: "running", pid: 4242, exitCode: undefined,
        readOutput: () => ({ delta: "Started App\n", lossy: false }),
        kill() { proc.status = "killed"; return true; }, done: Promise.resolve(),
      };
      return proc;
    },
  },
  on: () => () => {},
};
const plugin = await import(
  pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url)))
);
plugin.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

// 1. inspect reports the workspace-resolution facts
const insp = await byName.spring_boot_inspect.execute({ dir: appDir }, {});
assert.ok(insp.matched, "matched");
assert.deepStrictEqual(insp.internalDeps, ["common"], "internal dep detected: " + JSON.stringify(insp.internalDeps));
assert.deepStrictEqual(insp.internalDepsMissingInM2, ["common"], "missing in m2");
assert.strictEqual(insp.internalDepsResolvableByWorkspace, true, "workspace-resolvable");
assert.ok(insp.reactorRoot && insp.reactorRoot.endsWith("dsh-spring-boot-fixture-wsres"), "reactor root found");
console.log("✓ inspect:", JSON.stringify({
  internalDeps: insp.internalDeps, missingInM2: insp.internalDepsMissingInM2,
  resolvable: insp.internalDepsResolvableByWorkspace,
}));

// 2. auto start routes to direct-classpath (workspace resolution)
const r = await byName.spring_boot_start.execute({ dir: appDir, detach: true }, { signal: {} });
assert.ok(!r.isError, "start ok: " + JSON.stringify(r.error || null));
assert.strictEqual(r.mode, "direct-classpath", "workspace route, got " + r.mode);
const cmd = captured.at(-1).command;
// ONLY the declared dep mounts — sibling-app must NOT (bean-conflict trap)
assert.ok(cmd.includes("..\\..\\common\\target\\classes"), "declared dep on cp: " + cmd);
assert.ok(!cmd.includes("sibling-app"), "co-resident app NOT on cp: " + cmd);
// src resources fill the config gap
// src/main/resources must NOT ride the classpath: Spring 2.4+ config-data
// ADDS every classpath application.yml (no first-wins), so the unfiltered
// src copy (@project.version@) blows up SnakeYAML even when the filtered
// target/classes copy exists (observed on example-service).
assert.ok(!cmd.includes("src\\main\\resources"), "src resources NOT on cp (additive config-data trap)");
// assembly lib location (not target/lib)
assert.ok(cmd.includes("target\\assem\\lib\\*"), "assembly lib wildcard: " + cmd);
console.log("✓ direct-classpath:", cmd.slice(cmd.indexOf("-cp"), cmd.indexOf(" a.App")));
console.log("  reasons:", (r.modeReasons || []).filter((x) => x.includes("internal deps")).join(" | "));

// 3. sibling-app declares NO internal dep → the internal-dep route does not
// fire; auto mode falls through to plain dev-run (or its own classes path),
// and crucially NO undeclared sibling classes are mounted anywhere.
const r2 = await byName.spring_boot_start.execute({ dir: join(ROOT, "service-parent", "sibling-app"), detach: true }, { signal: {} });
assert.ok(!r2.isError, "sibling app start ok: " + JSON.stringify(r2.error || null));
const cmd2 = captured.at(-1).command;
assert.ok(!cmd2.includes("..\\..\\common\\target\\classes"),
  "undeclared common NOT mounted for a project that doesn't depend on it: " + cmd2.slice(0, 200));
assert.ok(!cmd2.includes("service-parent\\app"),
  "co-resident app classes NOT mounted for sibling-app either");

// 4. TRANSITIVE internal dep + dev-run-classpath: app→common→common2, and
// common2 has NO classes. The reactor prepare's copy-dependencies must
// exclude the WHOLE closure (MDEP-187 fires on any -am-built reactor
// artifact that enters the walk — observed live when dim-core→shared-core
// slipped past a direct-deps-only exclude). common2 was created up front to
// dodge the 60s inspect cache.
{
  // stop the app first (case 2's fake process still "running")
  await byName.spring_boot_stop.execute({ dir: appDir });
  const insp4 = await byName.spring_boot_inspect.execute({ dir: appDir }, {});
  assert.ok(insp4.internalDepArtifactIds.includes("common2"),
    "transitive internal dep in closure: " + JSON.stringify(insp4.internalDepArtifactIds));
  const r4 = await byName.spring_boot_start.execute({ dir: appDir, mode: "dev-run-classpath", detach: true }, { signal: {} });
  assert.ok(!r4.isError, "4: no error: " + JSON.stringify(r4.error || null));
  const cmd4 = captured.at(-1).command;
  // command is wrapForPwshExec-escaped (quotes doubled); slice the raw
  // exclude segment between the flag and -q.
  const exStart = cmd4.indexOf("excludeArtifactIds=");
  const exEnd = cmd4.indexOf("-q", exStart);
  const exRaw = cmd4.slice(exStart, exEnd);
  assert.ok(exRaw.includes("common") && exRaw.includes("common2"),
    "4: exclude covers the FULL closure (direct + transitive): " + exRaw);
  console.log("✓ MDEP-187 exclude closure:", exRaw.replace(/""/g, ""));
}

rmSync(ROOT, { recursive: true, force: true });
console.log("\nWORKSPACE-RESOLUTION SMOKE TESTS PASSED");
process.exit(0);
