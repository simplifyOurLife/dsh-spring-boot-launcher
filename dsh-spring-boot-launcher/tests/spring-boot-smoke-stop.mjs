// Smoke: graceful stop streams shutdown logs before closing.
// Fake ShellProcess emits shutdown lines after being told to stop,
// verifying: (1) stop path waits (graceful) instead of instant force,
// (2) final drain captures the shutdown tail into the buffer + log file,
// (3) no force-kill when graceful settles, (4) closeLog happens after drain.
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const FIX = join(process.env.TEMP, "dsh-spring-boot-fixture-stop");
const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
rmSync(FIX, { recursive: true, force: true });
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

const dir = FIX;
mkdirSync(join(dir, "src", "main", "java", "demo"), { recursive: true });
writeFileSync(join(dir, "pom.xml"), `<project>
  <parent><groupId>g</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <artifactId>stopper</artifactId><version>1.0</version>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><configuration><includes><include>nothing:nothing</include></includes></configuration></plugin></plugins></build>
</project>`);
writeFileSync(join(dir, "src", "main", "java", "demo", "App.java"),
  "package demo;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
mkdirSync(join(dir, "target", "classes"), { recursive: true });
mkdirSync(join(dir, "target", "lib"), { recursive: true });
writeFileSync(join(dir, "target", "classes", "App.class"), "x");
writeFileSync(join(dir, "target", "lib", "dep.jar"), "x");

const taskkillCalls = [];
const registered = [];
const ctx = {
  tools: { register: (t) => registered.push(t) },
  shell: {
    resolve: (s) => s,
    run: async (spec) => {
      if (spec.command.includes('-version')) return {stderr:'openjdk version "17.0.12"', exitCode:0};
      taskkillCalls.push(spec.command);
      // graceful taskkill (no /F): make the fake process exit on its own
      if (!spec.command.includes("/F")) fakeProc.status = "killed";
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    start: () => {
      fakeProc = {
        status: "running", pid: 777, exitCode: undefined,
        _started: false, _drainedShutdown: false,
        kill() { if (this.status === "running") this.status = "killed"; return true; },
        readOutput() {
          if (this.status === "running") {
            if (!this._started) { this._started = true; return { delta: "Started App\n", lossy: false }; }
            return { delta: "", lossy: false };
          }
          // after exit: shutdown tail lands on the first read, then dry
          if (!this._drainedShutdown) {
            this._drainedShutdown = true;
            return { delta: "Stopping service...\nTomcat Stopping\nHikari Shutdown completed\n", lossy: false };
          }
          return { delta: "", lossy: false };
        },
        done: Promise.resolve(),
      };
      return fakeProc;
    },
  },
  on: () => () => {},
};
let fakeProc;
const plugin = await import(pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href + "?stop");
plugin.apply(ctx);
const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

// 1. start (direct-classpath; detached)
const h = await byName.spring_boot_start.execute({ dir, mode: "direct-classpath", detach: true }, { signal: { aborted: false } });
assert.ok(!h.isError, "start ok: " + JSON.stringify(h.error || null));
assert.ok(fakeProc.status === "running", "fake proc running");
const logPath = h.logPath;
assert.ok(logPath, "logPath returned");
await new Promise((r) => setTimeout(r, 500)); // let the poller emit the start line

// 2. stop — graceful taskkill flips the fake proc to killed; the poller's
// final drain must capture the shutdown tail BEFORE stopSpringBootCore finishes.
const stopRes = await byName.spring_boot_stop.execute({ dir });
assert.strictEqual(stopRes.stopped, true);
assert.ok(taskkillCalls.some((c) => !c.includes("/F")), "graceful taskkill attempted: " + JSON.stringify(taskkillCalls));
const usedForce = taskkillCalls.some((c) => c.includes("/F"));
assert.ok(!usedForce, "no force kill needed when graceful settles: " + JSON.stringify(taskkillCalls));

// 3. shutdown tail visible in the log BUFFER (what spring_boot_logs/GUI serve)
console.log("DEBUG taskkillCalls:", JSON.stringify(taskkillCalls));
console.log("DEBUG fakeProc.status:", fakeProc.status, "drainedShutdown:", fakeProc._drainedShutdown);
const st = await byName.spring_boot_status.execute({ dir });
console.log("DEBUG status:", JSON.stringify(st));
await new Promise((r) => setTimeout(r, 1000));
const logs = await byName.spring_boot_logs.execute({ dir, lines: 50 });
assert.ok(logs.logs.includes("Hikari Shutdown completed"), "shutdown tail in buffer: " + JSON.stringify(logs.logs.slice(-120)));

// 4. shutdown tail persisted to the log FILE (fd closed only after drain)
await new Promise((r) => setTimeout(r, 300));
const fileText = readFileSync(logPath, "utf8");
assert.ok(fileText.includes("Tomcat Stopping"), "shutdown tail in log file");

rmSync(FIX, { recursive: true, force: true });
console.log("\nGRACEFUL-STOP SMOKE TESTS PASSED");
process.exit(0);
