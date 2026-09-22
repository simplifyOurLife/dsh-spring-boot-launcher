// Smoke tests for the "no target/" and "stale target/" user question:
//  A. crippled pom + NO target/           → dev-run-classpath WITH compile
//  B. crippled pom + fresh classes        → direct-classpath
//  C. crippled pom + STALE classes        → dev-run-classpath (no old bytecode)
//  D. stale thin-jar + no fresh classes   → dev-run-classpath (not jar-run)
//  E. stale thin-jar + fresh classes      → direct-classpath (existing behavior)
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const ROOT = join(process.env.TEMP, "dsh-spring-boot-fixture-t");
const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

const CRIPPLED_POM = `<project>
  <parent><groupId>g</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <artifactId>appmod</artifactId><version>1.0</version>
  <build><plugins><plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration><includes><include>nothing:nothing</include></includes></configuration>
  </plugin></plugins></build>
</project>`;
const APP_JAVA = ["package demo;", "@org.springframework.boot.autoconfigure.SpringBootApplication", "public class App {", "  public static void main(String[] a) {}", "}", ""].join("\n");

function fixture(name) {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "src", "main", "java", "demo"), { recursive: true });
  mkdirSync(join(dir, "src", "main", "resources"), { recursive: true });
  writeFileSync(join(dir, "pom.xml"), CRIPPLED_POM);
  writeFileSync(join(dir, "src", "main", "java", "demo", "App.java"), APP_JAVA);
  return dir;
}
function touchLater(p) {
  const t = new Date(Date.now() + 5000);
  utimesSync(p, t, t);
}

const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: (spec) => {
      captured.push(spec);
      return {
        status: "running", pid: 9, exitCode: undefined,
        readOutput: () => ({ delta: "Started App\n", lossy: false }),
        kill() { return true; }, done: Promise.resolve(),
      };
    },
  },
  on: () => () => {},
};
const captured = [];
const plugin = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href);
plugin.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
const execAbort = { signal: { aborted: true } };

async function startDir(dir, label) {
  const r = await byName.spring_boot_start.execute({ dir, detach: true }, execAbort);
  assert.ok(!r.isError, `${label} must not error: ` + JSON.stringify(r.error || null));
  console.log(`✓ ${label}: mode=${r.mode}`);
  console.log(`   cmd: ${r.cmd.slice(0, 150)}`);
  for (const reason of r.modeReasons || []) console.log(`   · ${reason.slice(0, 120)}`);
  return r;
}

// A. no target/ at all → dev-run-classpath with compile in the mvn chain
{
  const dir = fixture("no-target");
  const r = await startDir(dir, "A no-target");
  assert.strictEqual(r.mode, "dev-run-classpath", "A: mode");
  assert.ok(r.cmd.includes("mvn "), "A: has mvn");
  assert.ok(/mvn [^&]*compile/.test(r.cmd), "A: mvn chain includes compile: " + r.cmd);
  assert.ok(r.cmd.includes("dependency:copy-dependencies"), "A: copies deps");
  assert.ok(r.cmd.includes("java.exe") && r.cmd.includes("-cp"), "A: java -cp launch follows mvn prepare");
  assert.ok(r.cmd.includes("App"), "A: main class");
}

// B. fresh target/classes + lib → direct-classpath (no mvn)
{
  const dir = fixture("fresh-target");
  mkdirSync(join(dir, "target", "classes"), { recursive: true });
  mkdirSync(join(dir, "target", "lib"), { recursive: true });
  writeFileSync(join(dir, "target", "lib", "some-dep.jar"), "x");
  writeFileSync(join(dir, "target", "classes", "App.class"), "x"); // newer than src
  touchLater(join(dir, "target", "classes", "App.class"));
  const r = await startDir(dir, "B fresh-target");
  assert.strictEqual(r.mode, "direct-classpath", "B: mode");
  assert.ok(!r.cmd.includes("mvn "), "B: no mvn");
}

// C. STALE target/classes (src newer) → compile route, not old bytecode
{
  const dir = fixture("stale-classes");
  mkdirSync(join(dir, "target", "classes"), { recursive: true });
  mkdirSync(join(dir, "target", "lib"), { recursive: true });
  writeFileSync(join(dir, "target", "lib", "some-dep.jar"), "x");
  writeFileSync(join(dir, "target", "classes", "App.class"), "old bytecode");
  // classes old, src newer → stale
  const old = new Date(Date.now() - 60000);
  utimesSync(join(dir, "target", "classes", "App.class"), old, old);
  touchLater(join(dir, "src", "main", "java", "demo", "App.java"));
  const r = await startDir(dir, "C stale-classes");
  assert.strictEqual(r.mode, "dev-run-classpath", "C: mode must be compile route");
  assert.ok(/mvn [^&]*compile/.test(r.cmd), "C: includes compile");
  assert.ok(r.modeReasons.some((x) => x.includes("STALE")), "C: staleness explained");
}

// D. stale thin-jar, classes missing → compile route (never stale jar-run)
{
  const dir = fixture("stale-jar");
  mkdirSync(join(dir, "target", "lib"), { recursive: true });
  writeFileSync(join(dir, "target", "appmod-1.0.jar"), "thin");
  writeFileSync(join(dir, "target", "lib", "some-dep.jar"), "x");
  touchLater(join(dir, "src", "main", "java", "demo", "App.java")); // src newer than jar
  const r = await startDir(dir, "D stale-jar-no-classes");
  assert.strictEqual(r.mode, "dev-run-classpath", "D: mode must be compile route");
  assert.ok(r.modeReasons.some((x) => x.includes("STALE")), "D: staleness explained");
}

// E. stale thin-jar + FRESH classes → direct-classpath (regression check)
{
  const dir = fixture("stale-jar-fresh-classes");
  mkdirSync(join(dir, "target", "classes"), { recursive: true });
  mkdirSync(join(dir, "target", "lib"), { recursive: true });
  writeFileSync(join(dir, "target", "appmod-1.0.jar"), "thin");
  writeFileSync(join(dir, "target", "lib", "some-dep.jar"), "x");
  const fresh = new Date(Date.now() + 8000);
  const old = new Date(Date.now() - 60000);
  utimesSync(join(dir, "target", "appmod-1.0.jar"), old, old); // jar old
  writeFileSync(join(dir, "target", "classes", "App.class"), "x"); // classes newest
  utimesSync(join(dir, "target", "classes", "App.class"), fresh, fresh);
  const r = await startDir(dir, "E stale-jar-fresh-classes");
  assert.strictEqual(r.mode, "direct-classpath", "E: mode");
  assert.ok(r.modeReasons.some((x) => x.includes("STALE") || x.includes("fresher")), "E: staleness explained");
}

rmSync(ROOT, { recursive: true, force: true });
console.log("\nTARGET-STATE SMOKE TESTS PASSED");
process.exit(0);
