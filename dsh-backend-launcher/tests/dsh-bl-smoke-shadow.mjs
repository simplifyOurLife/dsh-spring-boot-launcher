// Shadowing-API-jar test: a lib containing servlet-api-2.5 + jsp-api-2.1
// beside an embedded server jar must EXCLUDE them from the -cp, and a lib
// without an embed container keeps the wildcard.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert";

const FIX = join(process.env.TEMP, "dsh-bl-fixture-shadow");
const MOCK_JDK = join(process.env.TEMP, "jdk-mock");
rmSync(FIX, { recursive: true, force: true });
mkdirSync(join(MOCK_JDK, "bin"), { recursive: true });
writeFileSync(join(MOCK_JDK, "bin", "java.exe"), "mock");
process.env.JAVA_HOME = MOCK_JDK;

function makeProject(name, libFiles, extra = {}) {
  const dir = join(FIX, name);
  mkdirSync(join(dir, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(join(dir, "pom.xml"), `<project>
  <parent><groupId>g</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>
  <artifactId>${name}</artifactId><version>1.0</version>
  ${extra.crippled ? "<build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId><configuration><includes><include>nothing:nothing</include></includes></configuration></plugin></plugins></build>" : ""}
</project>`);
  writeFileSync(join(dir, "src", "main", "java", "demo", "App.java"),
    "package demo;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n");
  mkdirSync(join(dir, "target", "classes"), { recursive: true });
  mkdirSync(join(dir, "target", "lib"), { recursive: true });
  writeFileSync(join(dir, "target", "classes", "App.class"), "x");
  for (const f of libFiles) writeFileSync(join(dir, "target", "lib", f), "x");
  return dir;
}

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
        status: "running", pid: 5, exitCode: undefined,
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
const execAbort = { signal: { aborted: true } };

// 1. Hadoop-style pollution: servlet-api-2.5 + jsp-api-2.1 next to tomcat-embed
{
  const dir = makeProject("poluted", [
    "aaa-1.0.jar", "servlet-api-2.5.jar", "jsp-api-2.1.jar",
    "spring-boot-starter-tomcat-2.7.18.jar", "tomcat-embed-core-9.0.83.jar",
    "zzz-1.0.jar",
  ], { crippled: true });
  const r = await byName.spring_boot_start.execute({ dir, mode: "direct-classpath", detach: true }, execAbort);
  assert.ok(!r.isError, "1: no error: " + JSON.stringify(r.error || null));
  const cmd = captured.at(-1).command;
  assert.ok(!cmd.includes("servlet-api-2.5.jar"), "1: servlet-api excluded");
  assert.ok(!cmd.includes("jsp-api-2.1.jar"), "1: jsp-api excluded");
  assert.ok(cmd.includes("tomcat-embed-core"), "1: embed jar present");
  assert.ok(cmd.includes("aaa-1.0.jar") && cmd.includes("zzz-1.0.jar"), "1: others enumerated");
  assert.ok(r.modeReasons.some((x) => x.includes("classpath fix") && x.includes("servlet-api-2.5.jar")), "1: fix noted");
  console.log("✓ shadowing jars excluded:", cmd.slice(cmd.indexOf("-cp"), cmd.indexOf("-cp") + 120) + "…");
}

// 2. No embed container in lib → wildcard kept (nothing to shadow)
{
  const dir = makeProject("noembed", ["aaa-1.0.jar", "servlet-api-2.5.jar", "zzz-1.0.jar"], { crippled: true });
  const r = await byName.spring_boot_start.execute({ dir, mode: "direct-classpath", detach: true }, execAbort);
  assert.ok(!r.isError, "2: no error");
  const cmd = captured.at(-1).command;
  assert.ok(cmd.includes("target\\lib\\*"), "2: wildcard kept without embed jar");
  console.log("✓ no-embed lib keeps wildcard");
}

// 3. Clean lib (no legacy API jars) → wildcard kept, short command
{
  const dir = makeProject("clean", ["aaa-1.0.jar", "tomcat-embed-core-9.0.83.jar", "zzz-1.0.jar"], { crippled: true });
  const r = await byName.spring_boot_start.execute({ dir, mode: "direct-classpath", detach: true }, execAbort);
  assert.ok(!r.isError, "3: no error");
  const cmd = captured.at(-1).command;
  assert.ok(cmd.includes("target\\lib\\*"), "3: wildcard kept when clean");
  console.log("✓ clean lib keeps wildcard");
}

// 4. POST-CLEAN dev-run-classpath: lib is EMPTY at classpath-compute time
// (mvn clean just wiped target/) — the wildcard pre-computes with nothing to
// enumerate-exclude, and copy-dependencies then brings servlet-api right
// back. The mvn chain must DELETE the shadowers AFTER the copy, BEFORE java.
{
  const dir = makeProject("postclean", [], { crippled: true }); // empty lib = post-clean
  const r = await byName.spring_boot_start.execute({ dir, detach: true }, { signal: {} });
  assert.ok(!r.isError, "4: no error: " + JSON.stringify(r.error || null));
  assert.ok(/dev-run-classpath/.test(r.mode), "4: empty lib routes to dev-run-classpath");
  const cmd = captured.at(-1).command;
  assert.ok(cmd.includes("copy-dependencies"), "4: mvn rebuilds deps");
  // shadow-del must appear between copy-dependencies and the java launch
  const cpAt = cmd.indexOf("copy-dependencies");
  // the command passes through wrapForPwshExec, which doubles quotes
  const delAt = cmd.indexOf('servlet-api-*.jar');
  const javaAt = cmd.indexOf("-cp ");
  assert.ok(cpAt !== -1 && delAt > cpAt, "4: shadow-del after copy-dependencies");
  assert.ok(javaAt > delAt, "4: java launch after shadow-del");
  assert.ok(cmd.includes("jsp-api-*.jar"), "4: jsp-api wildcard covered too");
  assert.ok(r.modeReasons.some((x) => x.includes("post-clean guard")), "4: guard noted in reasons");
  console.log("✓ post-clean: mvn copy → del shadowers → java");
}

rmSync(FIX, { recursive: true, force: true });
console.log("\nSHADOWING SMOKE TESTS PASSED");
process.exit(0);
