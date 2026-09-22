// Smoke: concurrent start race — two racing starts for the same dir must
// yield ONE process, the loser gets ALREADY_RUNNING (or START_RACE_LOST),
// never two JVMs.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

const FIX = join(process.env.TEMP, "dsh-bl-fixture-race");
rmSync(FIX, { recursive: true, force: true });
mkdirSync(join(FIX, "src", "main", "java", "demo"), { recursive: true });
writeFileSync(join(FIX, "pom.xml"), `<project>
  <parent><groupId>g</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <artifactId>racer</artifactId><version>1.0</version>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><configuration><includes><include>nothing:nothing</include></includes></configuration></plugin></plugins></build>
</project>`);
writeFileSync(join(FIX, "src", "main", "java", "demo", "App.java"),
  "package demo;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
mkdirSync(join(FIX, "target", "classes"), { recursive: true });
mkdirSync(join(FIX, "target", "lib"), { recursive: true });
writeFileSync(join(FIX, "target", "classes", "App.class"), "x");
writeFileSync(join(FIX, "target", "lib", "dep.jar"), "x");

let spawnCount = 0;
const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async () => ({ stdout: "", stderr: 'openjdk version "17.0.12"', exitCode: 0 }),
    start: () => {
      spawnCount++;
      return {
        status: "running", pid: 1000 + spawnCount, exitCode: undefined,
        readOutput: () => ({ delta: "Started App\n", lossy: false }),
        kill() { return true; }, done: Promise.resolve(),
      };
    },
  },
  on: () => () => {},
};
const plugin = await import(
  pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url)))
);
plugin.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

// fire two starts CONCURRENTLY
const [a, b] = await Promise.all([
  byName.spring_boot_start.execute({ dir: FIX, mode: "direct-classpath", detach: true }, { signal: {} }),
  byName.spring_boot_start.execute({ dir: FIX, mode: "direct-classpath", detach: true }, { signal: {} }),
]);

const oneWinner = !(a.isError && b.isError);
const loserCode = a.isError ? a.error.code : b.isError ? b.error.code : null;
assert.strictEqual(spawnCount, 1, "exactly ONE process spawned, got " + spawnCount);
assert.ok(oneWinner, "one of the two starts must succeed: " + JSON.stringify([a.error, b.error]));
assert.ok(loserCode === "ALREADY_RUNNING" || loserCode === "START_RACE_LOST",
  "loser gets a structured race code, got " + loserCode);
console.log("✓ concurrent start: 1 spawn, winner ok, loser →", loserCode);

// sequential re-start now reports ALREADY_RUNNING
const c = await byName.spring_boot_start.execute({ dir: FIX, mode: "direct-classpath", detach: true }, { signal: {} });
assert.strictEqual(c.isError && c.error.code, "ALREADY_RUNNING", "third start rejected");
console.log("✓ follow-up start → ALREADY_RUNNING");

rmSync(FIX, { recursive: true, force: true });
console.log("\nRACE SMOKE TESTS PASSED");
process.exit(0);
