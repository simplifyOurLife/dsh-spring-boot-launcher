// dsh-spring-boot-launcher — Maven Spring Boot process engine and GUI control server.
//
// Five DSH tools manage one Spring Boot service lifecycle:
//   spring_boot_inspect  — scan a project, return a structured launch profile
//   spring_boot_start    — compile + launch, poll health, broadcast logs
//   spring_boot_status   — running/pid/port/uptime/health
//   spring_boot_logs     — snapshot or follow log buffer
//   spring_boot_stop     — kill the process
//
// Process management uses ctx.shell (the DSH-blessed seam), NOT raw
// child_process. ctx.shell.start() gives a ShellProcess with readOutput()
// incremental reads + kill(), and respects sandbox policy.
//
// The GUI panel (dsh-spring-boot-launcher-ui) talks to the ControlServer below.
// start/stop go through the SAME core functions as the agent tools
// (startSpringBootCore / stopSpringBootCore), so the two entries cannot drift.
//
// Import: createRequire pointed at the DSH profile node_modules (cross-drive
// ESM bare-import resolution trap — see CONTRIBUTING.md).
import {
  readFileSync, existsSync, readdirSync, statSync,
  mkdirSync, openSync, appendFileSync, closeSync, rmSync, renameSync, fstatSync,
} from "node:fs";
import { join, basename, relative, resolve as resolvePath } from "node:path";
import * as net from "node:net";
import { assertSafeCommandValue, validateLaunchArgs, selectJdk } from './launch-policy.js';
import { pumpProcess } from './log-pump.js';
import { checkHealth } from './health-check.js';
import {openLogFile, closeLog, appendLog} from './log-storage.js';
import { readBody } from './control-body.js';
import { mountControlTransport } from './control-transport.js';
import { detectJdkCandidates } from './jdk-discovery.js';

import { defineTool, WebSocketServer } from './host-dependencies.js';

// Spring Boot processes must write (mvn → target/, JVM → logs/, ~/.m2 cache), so
// they cannot run under the deployment-default sandbox policy: a host-level
// ctx.shell.start without an explicit policy resolves to the deployment
// default, which on this setup confined the process read-only — mvn's
// copy-resources and logback's RollingFileAppender both died with 拒绝访问
// while the identical command run manually succeeded. The launcher's whole
// job is "click Run", so launch commands run explicitly unconfined.
const FULL_ACCESS_POLICY = { mode: "danger-full-access" };

// DSH validates that a tool's return value round-trips through JSON
// losslessly. An object key whose value is `undefined` serializes away and
// fails that check ("value is not lossless JSON") — inspect/start outputs are
// full of optional fields, so strip undefined recursively on every return.
function lossless(value) {
  if (Array.isArray(value)) return value.map(lossless);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = lossless(v);
    }
    return out;
  }
  return value;
}

// ANSI color escapes (logback %red/%highlight) make raw captures unreadable in
// an editor; strip them before persisting to the log file.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// ─── Control server constants ─────────────────────────────────────────────
const SERVICE_MARKER = "dsh-spring-boot-launcher";
// Log buffer cap per service: 512 KB tail. Long-running services must not
// grow the plugin heap without bound.
const MAX_LOG_BUFFER = 512 * 1024;
// How much recent log text a freshly-connected GUI gets per service.
const LOG_SNAPSHOT_CHARS = 8000;

// ─── Process Registry ─────────────────────────────────────────────────────
// In-memory map: projectKey → entry. Lives for the plugin fiber's lifetime.
// A process is killed when the owning composition tears down (ctx.subprocess
// disposal). Cross-session survival is an open problem (see DESIGN.md).
const processes = new Map();

function projectKey(dir) {
  // Stable key from the absolute path: last path segment + short hash.
  // Hash the case-normalized path on Windows so D:\Foo and d:\foo map to
  // the same service entry.
  const abs = resolvePath(dir);
  const base = basename(abs);
  const norm = process.platform === "win32" ? abs.toLowerCase() : abs;
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = ((hash << 5) - hash + norm.charCodeAt(i)) | 0;
  }
  return `${base}-${(hash >>> 0).toString(36).slice(0, 8)}`;
}

/**
 * Resolve a registry entry from either a project directory OR a projectKey.
 * The agent tools take `dir`; the GUI (and agent, sometimes) only knows the
 * projectKey. Accepting both keeps the two entries on one identifier space.
 */
function resolveEntry(dirOrKey) {
  if (!dirOrKey) return undefined;
  const abs = resolvePath(dirOrKey);
  const key = projectKey(abs);
  if (processes.has(key)) return { key, entry: processes.get(key) };
  if (processes.has(dirOrKey)) return { key: dirOrKey, entry: processes.get(dirOrKey) };
  const absNorm = process.platform === "win32" ? abs.toLowerCase() : abs;
  for (const [k, e] of processes) {
    const d = process.platform === "win32" ? e.projectDir.toLowerCase() : e.projectDir;
    if (d === absNorm || k === dirOrKey) return { key: k, entry: e };
  }
  return undefined;
}

/**
 * Open the engine-side log file for one Spring Boot service:
 * <dir>/logs/dsh-spring-boot-launcher.log (append mode). This is the file the user opens directly when a
 * start fails — it captures mvn output AND the JVM console, unlike the app's
 * own logback file which only exists once logging initializes. Returns the fd
 * or null when the logs dir can't be created/opened (never fatal: the buffer
 * and GUI stream still work).
 */

/**
 * Pull the diagnostic lines worth showing out of a raw log buffer: the
 * "Caused by:" chain, logback "ERROR in ..." appender errors, and access
 * denials. A plain tail-2000 slice starts mid-stack and cuts off exactly the
 * root-cause line users need (observed live: the Caused by sat above the slice
 * window while the message opened on "…alizeWithConventions").
 */
function extractRootCauses(logText) {
  if (!logText) return "";
  const picked = [];
  for (const line of logText.split(/\r?\n/)) {
    if (
      /^\s*Caused by:/.test(line) ||
      /^\s*ERROR in ch\.qos\.logback/.test(line) ||
      /FileNotFoundException|AccessDeniedException|拒绝访问/.test(line)
    ) {
      const t = line.trim();
      if (!picked.includes(t)) picked.push(t);
    }
  }
  return picked.slice(0, 12).join("\n");
}

/**
 * When the crash is `Could not resolve placeholder 'X'`, find which of the
 * project's Spring profiles actually define X — the missing key is usually
 * a per-profile gap (dev-hb lacks secretkeyUrl; only aop-yun/aop-dev define
 * it), and naming the profiles that DO lets the agent retry with a working
 * profile instead of failing blind. Scans every application-<p>.yml and the
 * base application.yml in the project's config locations.
 */
function placeholderHint(dir, logText) {
  const m = String(logText || "").match(/Could not resolve placeholder '([^']+)'/);
  if (!m) return "";
  const key = m[1];
  const profiles = collectSpringProfiles(dir);
  const have = [];
  const roots = [
    join(dir, "src", "main", "resources"),
    join(dir, "src", "main", "resources", "config"),
    join(dir, "target", "classes"),
    join(dir, "target", "classes", "config"),
    join(dir, "target", "config"),
    join(dir, "config"),
  ];
  const check = (file, label) => {
    try {
      return readFileSync(file, "utf8").includes(key) ? label : null;
    } catch { return null; }
  };
  for (const r of roots) {
    const b = check(join(r, "application.yml"), "(base)");
    if (b && !have.includes(b)) have.push(b);
    for (const p of profiles) {
      const hit = check(join(r, `application-${p}.yml`), p);
      if (hit && !have.includes(hit)) have.push(hit);
    }
  }
  const hint = [`Placeholder hint: '${key}' is not defined in the profile you used.`];
  if (have.length > 0) {
    hint.push(`Profiles/configs that DO define it: ${have.join(", ")}. Retry with one of those (spring_boot_start dir=... profile=<one of them>).`);
  } else {
    hint.push(`No application-*.yml in this project defines '${key}' — it must come from an external config/env the app expects.`);
  }
  return hint.join(" ");
}

/**
 * Build the PROCESS_EXITED_EARLY message: extracted root causes first (the
 * part a tail slice keeps cutting off), then a raw tail, then the log-file
 * path so the user can open the full capture themselves.
 */
function earlyExitMessage(entry, context) {
  const causes = extractRootCauses(entry.logBuffer);
  const parts = [`Process exited before health check (${context}).`];
  if (causes) parts.push(`Root causes:\n${causes}`);
  // Profile-aware hint when the crash is a missing property placeholder.
  const hint = placeholderHint(entry.projectDir, entry.logBuffer);
  if (hint) parts.push(hint);
  parts.push(`Last logs (tail):\n${entry.logBuffer.slice(-1500)}`);
  if (entry.handle?.logPath) parts.push(`Full log file: ${entry.handle.logPath}`);
  return parts.join("\n\n");
}

/**
 * Detect a "thin jar" deployment layout in target/: a built jar whose
 * manifest carries a Class-Path pointing at config/ and lib/. For such
 * projects the correct run mode is `java -jar` (deployment style), because
 * resources are already filtered at package time and the manifest carries
 * the classpath. Returns the jar path, or undefined.
 */
function findThinJar(dir) {
  const targetDir = join(dir, "target");
  if (!existsSync(targetDir)) return undefined;
  let entries;
  try {
    entries = readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jar")) continue;
    // Skip original-/sources jars (spring-boot repackage artifacts)
    if (/^(original-|.*-sources)/.test(e.name)) continue;
    const jarPath = join(targetDir, e.name);
    // Thin-jar layout: a built jar beside a target/lib directory of deps
    // (manifest's Class-Path: config/ lib/... points at them). Presence of
    // target/lib with jars is the reliable fingerprint.
    const libDir = join(targetDir, "lib");
    try {
      if (existsSync(libDir) && readdirSync(libDir).some((f) => f.endsWith(".jar"))) {
        return jarPath;
      }
    } catch {
      /* unreadable lib dir — skip this jar */
    }
  }
  return undefined;
}

// ─── Staleness probing ─────────────────────────────────────────────────────
// A thin jar is a BUILD ARTIFACT: it snapshots the code at package time.
// Branch switches / source edits after packaging leave the jar stale while
// IDEA (classpath mode, running target/classes it recompiled) happily runs
// the NEW code. Observed live: jar built 08-28 on branch A, workspace
// switched to branch B on 08-31 — java -jar kept dying on DB connect while
// the same profile started fine from IDEA. The launcher must detect this
// gap instead of trusting the jar's existence.
const MTIME_TOLERANCE_MS = 2000;
const STALENESS_SCAN_CAP = 5000;

/**
 * Newest file mtime (ms) under a directory tree, recursively. Returns 0
 * when the root is missing/unreadable. Capped at STALENESS_SCAN_CAP entries
 * so huge trees cost bounded time (still milliseconds for typical Java
 * sources).
 */
function newestMtimeUnder(root) {
  if (!root || !existsSync(root)) return 0;
  let newest = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < STALENESS_SCAN_CAP) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (seen >= STALENESS_SCAN_CAP) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        seen++;
        try {
          const m = statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* file vanished mid-scan — ignore */
        }
      }
    }
  }
  return newest;
}

/**
 * Compare a build artifact against the current sources.
 * @returns { stale, artifactMtime, srcMtime } — stale is true only when
 * both timestamps resolved (>0) and the artifact predates the newest
 * source file beyond the tolerance. Unresolvable sides report stale:false
 * (fail-open: never block a launch just because we couldn't take a
 * timestamp).
 */
function artifactStale(artifactPath, srcRoot) {
  let artifactMtime = 0;
  try {
    artifactMtime = statSync(artifactPath).mtimeMs;
  } catch {
    return { stale: false, artifactMtime: 0, srcMtime: 0 };
  }
  const srcMtime = newestMtimeUnder(srcRoot);
  if (srcMtime === 0) {
    return { stale: false, artifactMtime, srcMtime: 0 };
  }
  const stale = artifactMtime + MTIME_TOLERANCE_MS < srcMtime;
  return { stale, artifactMtime, srcMtime };
}

// Launch-command builders shared by the decision-tree branch and the
// mvn-fail degrade path, so the two code paths can never drift on e.g.
// -Dserver.port quoting.

/**
 * A module's own artifactId (its pom's artifactId EXCLUDING the <parent>
 * block, whose artifactId belongs to the parent). undefined when unreadable.
 */
function moduleArtifactId(modDir) {
  try {
    let pom = readFileSync(join(modDir, "pom.xml"), "utf8");
    pom = pom.replace(/<parent>[\s\S]*?<\/parent>/, "");
    const m = pom.match(/<artifactId>([^<]+)<\/artifactId>/);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prune STALE internal-module jars from <dir>/target/lib. Direct-classpath
 * is the IDEA-equivalent mode: sibling target/classes dirs are on the
 * classpath, so the workspace code wins for every class that exists in both
 * places. But a class that exists ONLY in a stale internal jar (e.g.
 * MetadataCollectClient deleted from the new branch's dim-core source while
 * target/lib still holds the 08-20 dim-core-1.1.0.jar) still loads from the
 * jar and explodes at context refresh on beans the new branch no longer
 * defines. Shadowing cannot fix that — the jar must go. IDEA never has
 * internal jars on its classpath at all, so deleting a stale jar (build
 * output, regenerable via mvn) when the module's own target/classes exists
 * restores IDEA semantics. Jars whose module lacks fresh classes are kept
 * with a warning instead (removing them would break the launch outright).
 */
function pruneStaleInternalJars(dir, moduleDirs, notes) {
  for (const jar of collectStaleInternalJars(dir, moduleDirs)) {
    const jarPath = join(dir, "target", "lib", jar.name);
    if (jar.classesUsable) {
      try {
        rmSync(jarPath);
        notes.push(
          `pruned stale internal jar target/lib/${jar.name} (older than ${jar.artifactId} sources); ${jar.artifactId}/target/classes is on the classpath (IDEA-equivalent). Rerun mvn dependency:copy-dependencies to restore.`
        );
      } catch (e) {
        notes.push(`WARNING: stale internal jar target/lib/${jar.name} could not be deleted (${e.message}) — it may crash context refresh with beans the new branch no longer defines`);
      }
    } else {
      notes.push(
        `WARNING: target/lib/${jar.name} is STALE (older than ${jar.artifactId} sources) but ${jar.artifactId}/target/classes is missing — run "mvn install -pl ${jar.artifactId}" (or build it in IDEA) or the old jar's classes will run against new code`
      );
    }
  }
}

/**
 * Sibling module dirs for a launch dir: when dir IS the parent POM, its
 * <modules> children; when dir is a child module, the parent pom at dir/..
 * is probed for <modules>. Empty when neither applies.
 */
function discoverSiblingModuleDirs(dir, profile) {
  const moduleDirs = [];
  if (profile.modules && profile.modules.length > 0) {
    for (const m of profile.modules) moduleDirs.push(join(dir, m));
    return moduleDirs;
  }
  try {
    const parentPom = join(dir, "..", "pom.xml");
    if (existsSync(parentPom)) {
      const pp = readFileSync(parentPom, "utf8");
      const mm = pp.match(/<modules>([\s\S]*?)<\/modules>/);
      if (mm) {
        for (const m of mm[1].matchAll(/<module>([^<]+)</g)) {
          moduleDirs.push(join(dir, "..", m[1].trim()));
        }
      }
    }
  } catch { /* unreadable parent pom — no sibling resolution */ }
  return moduleDirs;
}

/**
 * Internal-module jars in <dir>/target/lib that are STALE relative to their
 * own module's sources: [{ name, artifactId, classesUsable }]. See
 * pruneStaleInternalJars for why these must never reach a context scan.
 */
function collectStaleInternalJars(dir, moduleDirs) {
  const out = [];
  const libDir = join(dir, "target", "lib");
  if (!existsSync(libDir)) return out;
  let files;
  try {
    files = readdirSync(libDir);
  } catch (error) {
    throw new Error(`无法扫描工作区 ${absRoot}：${error.code || error.message}`);
  }
  for (const modDir of moduleDirs) {
    if (resolvePath(modDir) === resolvePath(dir)) continue; // never prune own jar
    const artifactId = moduleArtifactId(modDir);
    if (!artifactId) continue;
    for (const f of files) {
      if (!f.startsWith(`${artifactId}-`) || !f.endsWith(".jar")) continue;
      const staleness = artifactStale(join(libDir, f), join(modDir, "src", "main"));
      if (staleness.stale) {
        out.push({
          name: f,
          artifactId,
          classesUsable: existsSync(join(modDir, "target", "classes")),
        });
      }
    }
  }
  return out;
}

/**
 * Jars that shadow the embedded server's own API classes when the wildcard
 * `target\lib\*` expands alphabetically. Classic case: hadoop-common drags in
 * servlet-api-2.5.jar, which sorts BEFORE tomcat-embed-core, so Tomcat 9
 * loads the Servlet 2.5 ServletContext and dies with NoSuchMethodError
 * getVirtualServerName (a Servlet 4.0 method) — while IDEA starts fine
 * because its Maven-ordered classpath puts starter-tomcat first. The
 * embedded jar carries the complete, correct API, so excluding the legacy
 * API-only jar from the CLASSPATH (not deleting it: jar-run and packaging
 * may still reference it) restores IDEA semantics.
 */
const SHADOWING_API_JARS = /^(servlet-api|jsp-api)-\d/;

/**
 * Expand `target\lib\*` into explicit entries minus shadowing jars when any
 * embed-container jar exists to provide the API instead. Returns the
 * wildcard when there is nothing to fix. Notes explain every exclusion.
 */
function libEntries(dir, notes, libRelDir) {
  // libRelDir: the lib dir RELATIVE to dir — "target\lib" or an assembly
  // layout like "target\service-api\lib" (dep-separation repos).
  const rel = libRelDir || "target\\lib";
  const libDir = join(dir, rel);
  let files;
  try {
    files = readdirSync(libDir).filter((f) => f.endsWith(".jar"));
  } catch {
    return [`${rel}\\*`];
  }
  const hasEmbed = files.some((f) => /^(tomcat-embed|jetty-[0-9]|undertow-core)-/.test(f) || /spring-boot-starter-(tomcat|jetty|undertow)/.test(f));
  const shadowers = files.filter((f) => SHADOWING_API_JARS.test(f));
  if (!hasEmbed || shadowers.length === 0) return [`${rel}\\*`];
  // Exclude by listing everything except the shadowers. Enumeration cost:
  // ~40 chars/jar → 300 jars ≈ 12KB, still safely under the Windows ~32KB
  // CreateProcess limit (the 568-jar/24KB failure that motivated the wildcard
  // happened at lib sizes we deliberately refuse to enumerate).
  const keep = files.filter((f) => !SHADOWING_API_JARS.test(f));
  if (keep.length > 300) {
    notes.push(
      `WARNING: ${shadowers.join(", ")} shadow the embedded server's servlet API (sorts first in ${rel}\\*), and lib is too large to enumerate — consider removing them from the pom (scope provided/exclusion)`
    );
    return [`${rel}\\*`];
  }
  for (const s of shadowers) {
    notes.push(
      `classpath fix: excluded ${rel}/${s} (legacy servlet/jsp API-only jar; the embedded server jar carries the complete API — IDEA's Maven-ordered classpath hides this conflict, the alphabetical wildcard exposes it)`
    );
  }
  return keep.map((f) => `${rel}\\${f}`);
}

/**
 * Build the classpath segment list for direct-classpath mode. Returns
 * ["<sibling>\\target\\classes", ..., "target\\classes", "target\\config",
 *  "target\\lib\\*"] or [] when nothing usable is present.
 *
 * Three deliberate choices, each learned the hard way:
 * - SIBLING MODULES FIRST (IDEA-equivalent workspace resolution): when dir
 *   sits in a multi-module build, every sibling module's target/classes
 *   goes on the classpath AHEAD of target/lib. Reason: target/lib carries
 *   package-time copies of the INTERNAL modules (e.g. dim-core-1.1.0.jar
 *   from 08-20) which can reference beans the new branch deleted —
 *   observed live as NoSuchBeanDefinition for a @Qualifier that exists
 *   ONLY inside the old jar while IDEA (workspace classpath) started fine.
 *   Classes shadow by order: sibling classes first, stale internal jars
 *   never load their class versions.
 * - target/lib is ONE wildcard entry, never per-jar enumeration: a 568-jar
 *   lib enumerated inline overflows the Windows ~32KB CreateProcess limit
 *   ("The command line is too long", cmd.exe's face of error=206). Java's
 *   `-cp dir\*` wildcard (expands every *.jar in that dir) exists exactly
 *   for this.
 * - Top-level target/*.jar is NOT on the classpath: package-time artifacts
 *   (possibly stale) shadowing fresh classes. jar-run exists for the jar.
 *
 * Sibling discovery: profile.modules (parent-pom modules, when dir IS the
 * parent), else the parent pom at dir/.. is probed for <modules> (when dir
 * is a child module). Only siblings with an existing target/classes count.
 */
function buildDirectClasspath(dir, profile) {
  const parts = [];
  const notes = [];
  // Sibling module resolution (IDEA-equivalent workspace classpath). Use the
  // FULL reactor module set when a reactor root is known — cross-level deps
  // Sibling classes for the workspace classpath — IDEA mounts the modules the
  // project DEPENDS ON, never co-resident applications: mounting service-
  // portal next to service-api makes component-scan find two
  // customWebMvcConfig beans and die (ConflictingBeanDefinitionException,
  // observed live). Two distinct launch intents:
  //  - MODULE dir (has its own main class): mount EXACTLY the transitively
  //    declared internal deps (profile.internalDepDirs). Undeclared modules
  //    are not dependencies — IDEA would not mount them either.
  //  - AGGREGATOR parent dir (pom lists modules but the dir itself is not an
  //    app — the mainClass came from a CHILD): the user asked to run "the app
  //    in this repo", so mount every runnable child's classes, as before.
  const internalSet = new Set((profile.internalDepDirs || []).map((d) => resolvePath(d)));
  const allModules = (profile.reactorRoot
    ? collectReactorModules(profile.reactorRoot)
    : []).concat(
      // immediate-parent fallback for standalone projects
      discoverSiblingModuleDirs(dir, profile)
    ).filter((m) => resolvePath(m) !== resolvePath(dir));
  const dirIsAggregator = (profile.modules && profile.modules.length > 0) &&
    findSpringBootMainClass(dir) === undefined;
  const moduleDirs = dirIsAggregator
    ? allModules
    : allModules.filter((m) => internalSet.has(resolvePath(m)));
  let siblingsAdded = 0;
  for (const modDir of moduleDirs) {
    const modClasses = join(modDir, "target", "classes");
    try {
      if (existsSync(modClasses)) {
        // Relative to dir (the process CWD) so the -cp stays short. For the
        // module that IS dir this yields "target\\classes" — deduped below.
        parts.push(relative(dir, modClasses));
        siblingsAdded++;
      }
    } catch { /* ignore */ }
  }
  // Stale internal jars defeat workspace shadowing for classes the new
  // branch deleted — remove them (when their module has fresh classes) so
  // the context scan can't pick up old-branch orphans. See the function doc.
  pruneStaleInternalJars(dir, moduleDirs, notes);
  if (siblingsAdded > 0) {
    notes.push(
      `multi-module: ${siblingsAdded} sibling target/classes placed ahead of target/lib (IDEA-equivalent workspace resolution; shadows stale internal jars)`
    );
  }
  if (profile.targetClassesExist) parts.push("target\\classes");
  if (profile.targetConfigExists) parts.push("target\\config");
  // DO NOT add src/main/resources wholesale: Spring 2.4+ config-data loads
  // application.yml from EVERY classpath dir (additive, NOT first-wins), so
  // the unfiltered src copy (@project.version@ placeholders) would be parsed
  // even when the filtered target/classes copy exists → SnakeYAML
  // ScannerException (observed live on example-service). The config-gap
  // case is handled by the reactor prepare (mvn process-resources/compile
  // writes the filtered copies into target/classes) instead.
  if (profile.targetClassesExist && profile.assemblyLibJars === 0 && profile.targetLibJars === 0) {
    notes.push("WARNING: no third-party jar dir found — workspace launch will NoClassDefFoundError; the reactor prepare (mvn compile + copy-dependencies) should rebuild target before java runs");
  }
  // Third-party jars: dep-separation repos scatter them across layouts —
  // target/lib (copy-dependencies), target/<assembly-name>/lib (assembly
  // plugin, e.g. service-api's target/service-api/lib with
  // 378 jars). Probe each candidate and wildcard the first one that has
  // jars; without this the workspace-classpath launch dies on
  // NoClassDefFoundError: ApplicationContext (observed live).
  const libCandidates = [join(dir, "target", "lib")];
  try {
    const t = join(dir, "target");
    for (const e of readdirSync(t, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(t, e.name, "lib"))) {
        libCandidates.push(join(t, e.name, "lib"));
      }
    }
  } catch { /* unreadable target */ }
  let libFound = false;
  for (const cand of libCandidates) {
    try {
      if (readdirSync(cand).some((f) => f.endsWith(".jar"))) {
        const relCand = relative(dir, cand);
        notes.push(`third-party jars from ${relCand}`);
        parts.push(...libEntries(dir, notes, relCand));
        libFound = true;
        break;
      }
    } catch { /* unreadable candidate */ }
  }
  if (!libFound) {
    notes.push("WARNING: no third-party jar dir found (target/lib or target/*/lib empty/missing) — workspace launch will NoClassDefFoundError unless all deps are sibling classes; consider mode=reactor-run");
  }
  // Dedupe (order-preserving): the module list can contain dir itself, which
  // already pushed "target\\classes" above.
  const seen = new Set();
  const deduped = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return { parts: deduped, notes };
}

/**
 * Resolve the jar path for jar-run mode with the same priority the
 * decision tree uses. Returns path string or undefined.
 */
function resolveJarPath({ argsJarPath, profile, dir }) {
  if (argsJarPath) return argsJarPath;
  if (profile.thinJarPath) return profile.thinJarPath;
  return findThinJar(dir);
}

/**
 * Build the inner shell command (the string passed to `cmd.exe /c "..."`).
 * Returns { innerCmd, mode, usedJarPath?, error? }. On error, mode=undefined
 * and error.code/message populated; caller returns isError.
 */
function buildLaunchCommand({ mode, dir, profile, javaExe, argsJarPath, springProfile, extraJvm, portOverride, mvnOffline }) {
  try {
    // 同时检查来自 POM、目录扫描与环境变量的动态值，不能只检查 HTTP 参数。
    for (const [label, value] of Object.entries({dir, argsJarPath, springProfile, extraJvm,
      mainClass: profile.mainClass, reactorRoot: profile.reactorRoot, thinJarPath: profile.thinJarPath})) {
      if (value !== undefined && value !== null) assertSafeCommandValue(value, label);
    }
    for (const id of profile.internalDepArtifactIds || []) assertSafeCommandValue(id, 'artifactId');
  } catch (error) {
    return {mode, error:{code:'INVALID_ARGUMENT', message:error.message}};
  }
  const jvmParts = ["-Dfile.encoding=UTF-8"];
  if (springProfile) jvmParts.push(`-Dspring.profiles.active=${springProfile}`);
  if (extraJvm) jvmParts.push(extraJvm);
  if (portOverride) jvmParts.push(`-Dserver.port=${portOverride}`);

  // Log directory workaround. If dir/logs/ doesn't exist but dir/../logs/
  // does (typical of multi-module layouts that share a single logs/ at the
  // parent), inject -Duser.dir=<parent> so the child's logback-spring.xml
  // relative log path resolves to the parent logs/. Only meaningful for
  // JVM-launched modes (jar-run, direct-classpath); dev-run is an mvn
  // subprocess and its CWD is set by mvn, not us. We do this on the JVM side
  // rather than changing workdir, because workdir is also where target/ is
  // read from for classpath/file lookup.
  let userDirOverride = null;
  const notes = [];
  if ((mode === "jar-run" || mode === "direct-classpath") &&
      profile.parentLogsExists === true &&
      profile.moduleLogsExists === false) {
    userDirOverride = join(dir, "..");
    jvmParts.push(`"-Duser.dir=${userDirOverride}"`);
    notes.push(`workdir-shim: -Duser.dir=${userDirOverride} (dir/logs missing, using parent logs/)`);
  }

  if (mode === "jar-run") {
    const jarPath = resolveJarPath({ argsJarPath, profile, dir });
    if (!jarPath) {
      return { mode, error: { code: "JAR_NOT_FOUND", message: "mode=jar-run requested but no thin-jar found in target/" } };
    }
    return {
      mode,
      usedJarPath: jarPath,
      notes: notes.length ? notes : undefined,
      innerCmd: `${javaExe} ${jvmParts.join(" ")} -jar "${jarPath}"`,
    };
  }

  if (mode === "direct-classpath") {
    // buildDirectClasspath returns { parts, notes } — notes (sibling-module
    // shadowing info) must flow into the launch notes, not just the classpath.
    const { parts: cpParts, notes: cpNotes } = buildDirectClasspath(dir, profile);
    if (cpParts.length === 0) {
      return { mode, error: { code: "NO_CLASSPATH", message: "mode=direct-classpath requested but no target/classes, target/lib, or standalone jars in target/" } };
    }
    if (!profile.mainClass) {
      return { mode, error: { code: "MAIN_CLASS_NOT_FOUND", message: "mode=direct-classpath needs mainClass (scanned from @SpringBootApplication). Run mvn compile first or pass mode=dev-run." } };
    }
    const allNotes = [...notes, ...(cpNotes || [])];
    return {
      mode,
      notes: allNotes.length ? allNotes : undefined,
      innerCmd: `${javaExe} ${jvmParts.join(" ")} -cp "${cpParts.join(";")}" ${profile.mainClass}`,
    };
  }

  if (mode === "reactor-run") {
    // IDEA-fallback semantics for a MODULE inside a reactor whose internal
    // deps are missing from ~/.m2 and have no workspace classes: run from the
    // ROOT pom with -pl <module> -am so Maven builds the siblings in-reactor
    // (dependency:resolve then works without anyone running mvn install).
    if (!profile.reactorRoot) {
      return { mode, error: { code: "NO_REACTOR_ROOT", message: "mode=reactor-run requested but no reactor root pom found above this module" } };
    }
    if (!profile.mainClass) {
      return { mode, error: { code: "MAIN_CLASS_NOT_FOUND", message: "mode=reactor-run needs mainClass." } };
    }
    // -pl takes the module's path RELATIVE to the root pom.
    const relModule = relative(profile.reactorRoot, dir).replace(/\\/g, "/");
    let mvnCmd = `mvn ${mvnOffline !== false ? "-o " : ""}-f "${profile.reactorRoot}\\pom.xml" -pl "${relModule}" -am -Dmaven.test.skip=true spring-boot:run`;
    const jvmArguments = [
      springProfile ? `-Dspring.profiles.active=${springProfile}` : "",
      extraJvm,
      portOverride ? `-Dserver.port=${portOverride}` : "",
    ].filter(Boolean).join(" ");
    if (jvmArguments) {
      mvnCmd += ` -Dspring-boot.run.jvmArguments="${jvmArguments}"`;
    }
    return { mode, notes: [`reactor-run: building from root pom with -pl "${relModule}" -am (internal deps built in-reactor, no mvn install needed)`], innerCmd: mvnCmd };
  }

  if (mode === "dev-run-classpath") {
    if (!profile.mainClass) {
      return { mode, error: { code: "MAIN_CLASS_NOT_FOUND", message: "mode=dev-run-classpath needs mainClass. Run mvn compile first." } };
    }
    // Compile IS part of this mode: it is the universal "build from source"
    // route for a missing OR stale target/ (mvn compile runs the resources
    // phase first, so resources are covered too). dependency:copy-dependencies
    // refreshes target/lib from ~/.m2 — including stale INTERNAL jars, which
    // are then deleted before java starts (see the del chain) so the context
    // scan cannot pick up old-branch orphan classes; sibling target/classes
    // provide the module code instead (same IDEA-equivalence rule as
    // direct-classpath's prune).
    //
    // REACTOR MODE: when internal deps (sibling modules) are missing from
    // ~/.m2, a bare mvn in dir CANNOT resolve them (cloudera/offline
    // resolution failure). Running from the ROOT pom with -pl <module> -am
    // builds the siblings in-reactor so resolution succeeds without anyone
    // running mvn install. -Dmaven.test.skip and the phases apply to the
    // selected module; copy-dependencies' outputDirectory must then be
    // ABSOLUTE (relative -pl output dirs resolve against the root cwd).
    const { parts: cpParts, notes: cpNotes } = buildDirectClasspath(dir, profile);
    const cp = cpParts.length ? cpParts.join(";") : `target\\classes;target\\lib\\*`;
    const moduleDirs = discoverSiblingModuleDirs(dir, profile);
    const staleJars = collectStaleInternalJars(dir, moduleDirs);
    const dels = staleJars
      .filter((j) => j.classesUsable)
      .map((j) => `del /f /q "target\\lib\\${j.name}" 2>nul`)
      .join(" && ");
    // Reactor context whenever the module HAS internal deps at all — not
    // only when they're missing from ~/.m2. A branch switch can leave stale
    // A-branch jars IN ~/.m2 while target/ holds B-branch classes; either
    // way, copy-dependencies walking an -am-built reactor artifact dies with
    // MDEP-187 unless every internal artifactId is excluded (observed live
    // on shared-core). The -am build itself is harmless when deps resolve.
    const useReactor = profile.reactorRoot &&
      profile.internalDepArtifactIds && profile.internalDepArtifactIds.length > 0;
    let mvnPhases;
    if (useReactor) {
      const relModule = relative(profile.reactorRoot, dir).replace(/\\/g, "/");
      const absLib = join(dir, "target", "lib");
      // copy-dependencies cannot copy REACTOR-built artifacts that were never
      // packaged (MDEP-187) — exclude them; their classes ride the workspace
      // classpath anyway (that's the whole point of workspace resolution).
      // The exclude must be the FULL transitive closure (direct + everything
      // the -am build pulls in): excluding only direct deps let dim-core's
      // own dep on shared-core through and the copy goal died on shared-core.
      const excludeIds = (profile.internalDepArtifactIds && profile.internalDepArtifactIds.length
        ? profile.internalDepArtifactIds
        : profile.internalDeps || []).join(",");
      mvnPhases = `mvn ${mvnOffline !== false ? "-o " : ""}-f "${profile.reactorRoot}\\pom.xml" -pl "${relModule}" -am -Dmaven.test.skip=true compile dependency:copy-dependencies -DincludeScope=runtime -DexcludeArtifactIds="${excludeIds}" "-DoutputDirectory=${absLib}" -q`;
    } else {
      mvnPhases = `mvn ${mvnOffline !== false ? "-o " : ""}-Dmaven.test.skip=true compile dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=target/lib -q`;
    }
    const allNotes = [
      ...(cpNotes || []),
      ...(useReactor ? [`reactor prepare: mvn from root pom with -pl ${relative(profile.reactorRoot, dir).replace(/\\/g, "/")} -am (internal deps ${profile.internalDepsMissingInM2.join(", ")} built in-reactor, no mvn install needed)`] : []),
      ...staleJars.filter((j) => j.classesUsable).map((j) => `will delete re-copied stale internal jar target/lib/${j.name} after mvn prepare (${j.artifactId}/target/classes is on the classpath)`),
      ...staleJars.filter((j) => !j.classesUsable).map((j) => `WARNING: target/lib/${j.name} is stale and ${j.artifactId}/target/classes is missing — run "mvn install -pl ${j.artifactId}" or the old jar's classes run against new code`),
      // Post-clean shadowing guard (see SHADOWING_API_JARS): after a clean,
      // the classpath is pre-computed with an EMPTY lib (wildcard, nothing to
      // enumerate-exclude yet), then copy-dependencies brings the legacy
      // servlet-api/jsp-api right back — the Phase 2.12 shadowing trap
      // resurrects (observed: clean → start → NoSuchMethodError
      // getVirtualServerName). Deleting the shadowers AFTER the copy, BEFORE
      // java, is the only phase where they provably exist.
      "post-clean guard: deleting re-copied servlet-api-*.jar / jsp-api-*.jar after copy-dependencies (embedded server carries the correct API)",
    ];
    const javaPart = `${javaExe} ${jvmParts.join(" ")} -cp "${cp}" ${profile.mainClass}`;
    const shadowDel = `del /f /q "target\\lib\\servlet-api-*.jar" "target\\lib\\jsp-api-*.jar" 2>nul`;
    return {
      mode,
      notes: allNotes.length ? allNotes : undefined,
      innerCmd: `${mvnPhases} && ${shadowDel}${dels ? " && " + dels : ""} && ${javaPart}`,
    };
  }

  // dev-run: mvn spring-boot:run
  // -o (offline) by default: dsh-managed mvn runs can't reliably reach
  // internal mirrors (e.g. nexus), and metadata fetch failures cascade into
  // resource copy failures. Offline mode uses only ~/.m2/repository. Caller
  // can opt out via args.mvnOffline=false.
  let mvnCmd = `mvn ${mvnOffline !== false ? "-o " : ""}-Dmaven.test.skip=true spring-boot:run`;
  // Port override goes in as a JVM property, NEVER as a program argument:
  // apps with a WebApplicationType.NONE branch in main() treat ANY args as
  // "command-line collection mode" and exit (see CONTRIBUTING.md).
  const jvmArguments = [
    springProfile ? `-Dspring.profiles.active=${springProfile}` : "",
    extraJvm,
    portOverride ? `-Dserver.port=${portOverride}` : "",
  ].filter(Boolean).join(" ");
  if (jvmArguments) {
    mvnCmd += ` -Dspring-boot.run.jvmArguments="${jvmArguments}"`;
  }
  return { mode: "dev-run", innerCmd: mvnCmd };
}

/** Wrap an inner shell command in `cmd.exe /c "..."` with proper escaping. */
function wrapForPwshExec(innerCmd) {
  // PowerShell 单引号字符串不执行 $() 与反引号插值。
  return `cmd.exe /d /s /c '${('"' + innerCmd + '"').replace(/'/g, "''")}'`;
}

function inspectMavenProject(dir) {
  const pomPath = join(dir, "pom.xml");
  if (!existsSync(pomPath)) return { matched: false, why: "no pom.xml" };
  const pom = readFileSync(pomPath, "utf8");

  // Spring Boot version from <parent> or property
  let springBootVersion;
  const parentMatch = pom.match(
    /<parent>[\s\S]*?spring-boot-starter-parent[\s\S]*?<version>([^<]+)</
  );
  if (parentMatch) springBootVersion = parentMatch[1].trim();
  if (!springBootVersion) {
    const propMatch = pom.match(/<spring-boot\.version>([^<]+)</);
    if (propMatch) springBootVersion = propMatch[1].trim();
  }

  const javaVerMatch =
    pom.match(/<java\.version>([^<]+)</) ||
    pom.match(/<maven\.compiler\.source>([^<]+)</) ||
    pom.match(/<maven\.compiler\.release>([^<]+)</) ||
    pom.match(/<source>([^<]+)<\/source>/);
  const javaVersion = javaVerMatch ? javaVerMatch[1].trim() : undefined;

  const packagingMatch = pom.match(/<packaging>([^<]+)</);
  const packaging = packagingMatch ? packagingMatch[1].trim() : "jar";
  const hasSpringBootPlugin = /spring-boot-maven-plugin/.test(pom);
  // Detect if spring-boot:run is skipped or structurally crippled in the
  // plugin config. <skip>true</skip> disables run entirely; <includes>/<excludes>
  // (used for jar/dep-separation layouts — the pom comment literally says
  // "实现jar包与依赖分离") strip runtime deps from the forked classpath so
  // spring-boot:run dies with NoClassDefFoundError: SpringApplication. Both
  // mean dev-run is not viable; the decision tree routes to non-mvn modes.
  const sbPluginBlock = pom.match(
    /<artifactId>spring-boot-maven-plugin<\/artifactId>[\s\S]*?<\/plugin>/
  );
  const springBootRunSkipped = sbPluginBlock
    ? /<skip>\s*true\s*<\/skip>/.test(sbPluginBlock[0])
    : false;
  const springBootRunCrippled = sbPluginBlock
    ? /<(?:includes|excludes)>[\s\S]*?<(?:include|exclude)>/.test(sbPluginBlock[0])
    : false;

  const modules = [];
  const modulesMatch = pom.match(/<modules>([\s\S]*?)<\/modules>/);
  if (modulesMatch) {
    for (const m of modulesMatch[1].matchAll(/<module>([^<]+)</g))
      modules.push(m[1].trim());
  }

  let requiredJdk;
  if (springBootVersion) {
    const major = parseInt(springBootVersion, 10);
    if (major >= 4) requiredJdk = "21+";
    else if (major >= 3) requiredJdk = "17+";
    else requiredJdk = "8+";
  }

  const declaredJava = pom.match(/<(?:java.version|maven.compiler.release|maven.compiler.target)>\s*((?:1\.)?\d+)\s*</);
  if (declaredJava) requiredJdk = declaredJava[1].replace(/^1\./, '');

  // Find main class: scan src/main/java for @SpringBootApplication
  let mainClass = findSpringBootMainClass(dir);

  // Multi-module parent fallback. If dir has <modules> in pom but no
  // src/main/java of its own (typical of a multi-module parent POM like
  // dim-data-parent), walk each child module looking for the same things.
  // The first child that has @SpringBootApplication wins for mainClass.
  if (modules.length > 0) {
    for (const mod of modules) {
      const subDir = join(dir, mod);
      if (!existsSync(subDir)) continue;
      if (!mainClass) {
        const subMain = findSpringBootMainClass(subDir);
        if (subMain) mainClass = subMain;
      }
    }
  }

  // Parse application.yml for port/profile
  const appConfig = parseApplicationConfig(dir);
  // Spring profiles the project ships config for (GUI start panel picks one).
  const profiles = collectSpringProfiles(dir);

  // Run-mode decision gate (from run-modes.md):
  // - If spring-boot:run is skipped in POM, must use dev-run-classpath (java -cp)
  // - war packaging → legacy-run
  // - multi-module → per-module spring-boot:run
  // - otherwise → dev-run (mvn spring-boot:run)
  let recommendedMode;
  if (packaging === "war") recommendedMode = "legacy-run";
  else if (springBootRunSkipped || springBootRunCrippled)
    // Keep the recommendation consistent with pickMode: <skip>true</skip> AND
    // includes/excludes (dep-separation layout) both make spring-boot:run
    // non-viable — recommend the classpath route the start tree will take.
    recommendedMode = springBootRunSkipped
      ? "dev-run-classpath / direct-classpath (java -cp: spring-boot:run is skipped in POM)"
      : "dev-run-classpath / direct-classpath (java -cp: spring-boot:run crippled by includes/excludes in POM)";
  else if (modules.length > 0)
    recommendedMode = "dev-run (per-module: -pl <module> spring-boot:run)";
  else if (hasSpringBootPlugin) recommendedMode = "dev-run (mvn spring-boot:run)";
  else recommendedMode = "unknown";

  // Target state probe (used by the 5-way decision tree in spring_boot_start).
  // Probe target/ once so spring_boot_start can pick jar-run / direct-classpath
  // without re-scanning the filesystem.
  const targetDir = join(dir, "target");
  const targetClassesExist = existsSync(join(targetDir, "classes"));
  const targetConfigExists = existsSync(join(targetDir, "config"));
  let targetLibJars = 0;
  try {
    if (existsSync(join(targetDir, "lib"))) {
      targetLibJars = readdirSync(join(targetDir, "lib")).filter((f) =>
        f.endsWith(".jar")
      ).length;
    }
  } catch {
    /* ignore unreadable lib dir */
  }
  // Assembly-layout jars (target/<assembly-name>/lib): dep-separation repos
  // scatter their third-party jars here. Counted separately so the decision
  // tree knows third-party deps exist even when target/lib is empty.
  let assemblyLibJars = 0;
  try {
    for (const e of readdirSync(targetDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const alib = join(targetDir, e.name, "lib");
      if (existsSync(alib)) {
        assemblyLibJars += readdirSync(alib).filter((f) => f.endsWith(".jar")).length;
      }
    }
  } catch {
    /* ignore unreadable target */
  }
  // Thin-jar detection is shared with spring_boot_start via findThinJar (same
  // algorithm: target/*.jar + target/lib with at least one jar). Multi-module
  // parent fallback: if the dir itself has no thin-jar but pom has <modules>,
  // scan each child for one.
  // Staleness probe: is the thin jar (a package-time snapshot) older than
  // the current sources? Compare against the src/main of the project that
  // OWNS the jar: dir itself when found here, else the child module whose
  // target/ produced it (a parent POM dir has no src/main of its own).
  let thinJarDir = dir;
  let thinJarPath = findThinJar(dir);
  if (modules.length > 0 && !thinJarPath) {
    for (const mod of modules) {
      const subDir = join(dir, mod);
      if (!existsSync(subDir)) continue;
      const sub = findThinJar(subDir);
      if (sub) {
        thinJarPath = sub;
        thinJarDir = subDir;
        break;
      }
    }
  }
  // Log directory probe. Some Spring Boot projects (notably multi-module
  // layouts) ship a logback-spring.xml with relative log paths and a single
  // shared logs/ at the parent. If dir/logs/ doesn't exist but the parent
  // does, mark parentLogsExists so spring_boot_start can inject -Duser.dir=..
  // to redirect logback's relative paths.
  const moduleLogsExists = existsSync(join(dir, "logs"));
  const parentLogsExists = existsSync(join(dir, "..", "logs"));

  // Workspace-resolution probe (IDEA semantics): which <dependency> entries
  // point at SIBLING reactor modules? A bare `mvn spring-boot:run` in dir can
  // only resolve these from ~/.m2 — when they were never installed, dev-run
  // dies with "The POM for com.example:shared-core is missing" (observed live).
  // IDEA survives because it resolves them from the workspace instead.
  const reactorRoot = findReactorRoot(dir);
  // "Siblings" for dependency resolution are ALL modules of the reactor, not
  // just the ones under our immediate parent — service-api (nested
  // under service-parent) depends on shared-core (a TOP-LEVEL module).
  const siblingModuleDirs = reactorRoot ? collectReactorModules(reactorRoot) : [];
  const internalDeps = siblingModuleDirs.length > 0
    ? internalDepsVsSiblings(dir, siblingModuleDirs)
    : [];
  // Transitive closure over the siblings' OWN internal deps: the classpath
  // must carry what our deps themselves need (module graph, not flat list).
  // TWO lists come out of this walk:
  //  - internalDepDirs: modules WITH classes (for the workspace classpath)
  //  - internalDepArtifactIds: EVERY internal module in the closure, classes
  //    or not. copy-dependencies must exclude ALL of them: -am builds each
  //    sibling, and MDEP-187 fires on ANY un-packaged reactor artifact that
  //    enters the dependency walk — observed live when service-data's
  //    direct dep dim-core transitively pulls shared-core (which the direct-
  //    deps-only exclude missed → the copy goal died on shared-core).
  const internalDepDirs = [];
  const internalDepArtifactIds = new Set();
  const seenDepDirs = new Set([resolvePath(dir)]);
  const queue = internalDeps.map((d) => d.siblingDir);
  for (const d of internalDeps) internalDepArtifactIds.add(d.artifactId);
  while (queue.length > 0) {
    const m = queue.shift();
    const abs = resolvePath(m);
    if (seenDepDirs.has(abs)) continue;
    seenDepDirs.add(abs);
    internalDepArtifactIds.add(moduleArtifactId(abs));
    if (existsSync(join(abs, "target", "classes"))) {
      internalDepDirs.push(abs);
    }
    for (const trans of internalDepsVsSiblings(abs, siblingModuleDirs)) {
      queue.push(trans.siblingDir);
    }
  }
  const internalDepsMissingInM2 = internalDeps.filter((d) => {
    const gidPath = join(
      (process.env.USERPROFILE || process.env.HOME || ""), ".m2", "repository",
      ...d.groupId.split("."), d.artifactId
    );
    return !existsSync(gidPath);
  });
  const internalDepsResolvableByWorkspace = internalDeps.length > 0 &&
    internalDeps.every((d) => d.siblingClasses);

  // Staleness probe: is the thin jar (a package-time snapshot) older than
  // the current sources? Is target/classes (IDEA's recompiled output)
  // fresher than the sources? Both compare against the src/main of the
  // project that owns the artifact (dir, or the child module that produced
  // the jar). Unresolvable timestamps fail open (stale:false) — never
  // block a launch just because a timestamp couldn't be taken.
  const srcMainRoot = join(thinJarDir, "src", "main");
  const jarStale = thinJarPath
    ? artifactStale(thinJarPath, srcMainRoot)
    : { stale: false, artifactMtime: 0, srcMtime: 0 };
  const classesDir = join(dir, "target", "classes");
  const classesNewest = targetClassesExist ? newestMtimeUnder(classesDir) : 0;
  // A classes dir with no files (IDEA clean leftover) is NOT fresh — treating
  // it as usable would put an empty dir on the classpath.
  const targetClassesPopulated = classesNewest > 0;
  const srcNewest = jarStale.srcMtime || newestMtimeUnder(srcMainRoot);
  const targetClassesStale =
    targetClassesPopulated && srcNewest > 0 && classesNewest + MTIME_TOLERANCE_MS < srcNewest;

  return {
    matched: true,
    buildTool: "maven",
    springBootVersion,
    javaVersion,
    requiredJdk,
    packaging,
    hasSpringBootPlugin,
    springBootRunSkipped,
    springBootRunCrippled,
    modules,
    mainClass,
    port: appConfig.port,
    activeProfile: appConfig.activeProfile,
    profiles,
    recommendedMode,
    reactorRoot,
    internalDepDirs,
    internalDepArtifactIds: [...internalDepArtifactIds],
    internalDeps: internalDeps.map((d) => d.artifactId),
    internalDepsMissingInM2: internalDepsMissingInM2.map((d) => d.artifactId),
    internalDepsResolvableByWorkspace,
    targetClassesExist,
    targetClassesPopulated,
    targetConfigExists,
    targetLibJars,
    assemblyLibJars,
    thinJarPath,
    thinJarStale: jarStale.stale,
    thinJarMtime: jarStale.artifactMtime || undefined,
    srcNewestMtime: srcNewest || undefined,
    targetClassesStale,
    moduleLogsExists,
    parentLogsExists,
  };
}

function findSpringBootMainClass(dir) {
  const srcMain = join(dir, "src", "main", "java");
  if (!existsSync(srcMain)) return undefined;
  try {
    for (const file of walkJava(srcMain)) {
      const text = readFileSync(file, "utf8");
      // Also match the fully-qualified annotation form
      // (@org.springframework...boot.autoconfigure.SpringBootApplication),
      // which some projects write inline without the import.
      if (/@(?:(?:\w+\.)+)?SpringBootApplication\b/.test(text)) {
        const pkgMatch = text.match(/package\s+([\w.]+)\s*;/);
        const classMatch = text.match(
          /public\s+class\s+(\w+)[\s\S]*?(?:public\s+static\s+void\s+main)/
        );
        if (pkgMatch && classMatch) {
          return `${pkgMatch[1]}.${classMatch[1]}`;
        }
        if (classMatch) return classMatch[1];
      }
    }
  } catch {
    // ignore scan errors in spike
  }
  return undefined;
}

function* walkJava(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkJava(full);
    else if (e.name.endsWith(".java")) yield full;
  }
}

function parseApplicationConfig(dir) {
  const result = {};
  // Check application.yml / application.yaml / application.properties
  const candidates = [
    join(dir, "src", "main", "resources", "application.yml"),
    join(dir, "src", "main", "resources", "application.yaml"),
    join(dir, "src", "main", "resources", "application.properties"),
    join(dir, "src", "main", "resources", "config", "application.yml"),
    join(dir, "src", "main", "resources", "config", "application.properties"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    // Minimal YAML scraping for port and active profile
    const portMatch = text.match(/(?:^|\n)\s*port:\s*(\d+)/);
    if (portMatch) result.port = parseInt(portMatch[1], 10);
    const profileMatch = text.match(/(?:^|\n)\s*active:\s*(\S+)/);
    if (profileMatch) result.activeProfile = profileMatch[1].trim();
    // .properties style
    const propPort = text.match(/server\.port\s*=\s*(\d+)/);
    if (propPort) result.port = parseInt(propPort[1], 10);
    const propProfile = text.match(/spring\.profiles\.active\s*=\s*(\S+)/);
    if (propProfile) result.activeProfile = propProfile[1].trim();
    break;
  }
  return result;
}

/**
 * Spring profiles the project ships config for: every
 * application-<profile>.{yml,yaml,properties} found in the standard
 * resource locations (src, config/ subdir, and target's built copies —
 * thin-jar/dep-separation layouts may ONLY have the built copy). Returns a
 * sorted, deduped list of profile names. Used by the GUI start panel to let
 * the user pick instead of remembering names.
 */
function collectSpringProfiles(dir) {
  const found = new Set();
  const roots = [
    join(dir, "src", "main", "resources"),
    join(dir, "src", "main", "resources", "config"),
    join(dir, "target", "classes"),
    join(dir, "target", "classes", "config"),
    join(dir, "target", "config"),
    join(dir, "config"),
  ];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const f of entries) {
      const m = f.match(/^application-([^.]+)\.(?:yml|yaml|properties)$/);
      if (m) found.add(m[1]);
    }
  }
  return [...found].sort();
}

// ─── JDK detection ────────────────────────────────────────────────────────

async function probeJdkVersion(ctx, exec, jdkPath) {
  if (!ctx.shell) return undefined;
  try {
    const res = await ctx.shell.run(ctx.shell.resolve({
      command: `& '${join(jdkPath, "bin", "java.exe").replace(/'/g, "''")}' -version`,
      workdir: jdkPath,
      timeoutMs: 8000,
      signal: exec?.signal,
    }));
    if (res.timedOut || res.aborted || (res.exitCode !== undefined && res.exitCode !== 0)) {
      console.warn('[spring-boot-launcher] JDK 版本探测未成功退出:', jdkPath, res.exitCode);
      return undefined;
    }
    // DSH 的输出是 CollectedOutput{text,...}；兼容早期字符串返回值。
    // stderr 对象即使 text 为空仍为真，不能用 stderr || stdout 选择通道。
    const outputText = (output) => typeof output === 'string' ? output
      : typeof output?.text === 'string' ? output.text : '';
    const lines = (outputText(res.stderr) + '\n' + outputText(res.stdout)).split(/\r?\n/);
    const version = lines.map((line) => line.trim()).find((line) => /^(?:java|openjdk)\s+(?:version\s+)?"?\d+/i.test(line));
    if (!version) console.warn('[spring-boot-launcher] JDK 探测输出没有可识别版本:', jdkPath);
    return version;
  } catch (error) {
    console.warn('[spring-boot-launcher] JDK 版本探测失败:', jdkPath, error.message);
    return undefined;
  }
}

/**
 * Recursively expand a Maven parent's <modules> looking for RUNNABLE leaf
 * modules (Spring Boot main class or built artifacts). Depth-capped to keep
 * pathological trees bounded. Returns [{dir, name}] where name is the
 * parent→child path ("example-parent/service-parent/service-log").
 */
function expandRunnableModules(parentDir, namePrefix, depth) {
  const out = [];
  if (depth > 3) return out;
  let modules = [];
  try {
    modules = parseMavenModules(readFileSync(join(parentDir, "pom.xml"), "utf8"));
  } catch {
    return out;
  }
  for (const mod of modules) {
    const modDir = join(parentDir, mod);
    if (!existsSync(join(modDir, "pom.xml"))) continue;
    const label = namePrefix ? `${namePrefix}/${mod}` : mod;
    // Runnable = HAS A MAIN ENTRY (@SpringBootApplication / main method) —
    // IDEA's own criterion for its Services panel. Build artifacts do NOT
    // qualify: a library module like dim-core gets IDEA-compiled and has
    // target/classes, but it is a DEPENDENCY of service-data, not a
    // service (observed live: discover listed dim-core as startable).
    // hasArtifacts only matters later, for HOW a main-bearing module runs.
    if (findSpringBootMainClass(modDir) !== undefined) {
      out.push({ dir: modDir, name: label });
    }
    // nested parent: expand one level deeper regardless (leaf modules may
    // hide behind intermediate parents, e.g. service-parent).
    out.push(...expandRunnableModules(modDir, label, depth + 1));
  }
  return out;
}

// inspectMavenProject is heavyweight (src walk for main class + staleness
// mtime scans). The GUI calls it per project per panel open; results are
// stable for minutes at a time, so memoize per-dir with a short TTL and
// invalidate on start (a start mutates target/ state the profile reflects).
const INSPECT_TTL_MS = 60_000;
const inspectCache = new Map();

function inspectWithCache(dir) {
  const abs = resolvePath(dir);
  const hit = inspectCache.get(abs);
  if (hit && Date.now() - hit.at < INSPECT_TTL_MS) return hit.value;
  const value = inspectMavenProject(abs);
  inspectCache.set(abs, { at: Date.now(), value });
  return value;
}

function invalidateInspectCache(dir) {
  inspectCache.delete(resolvePath(dir));
  if (inspectCache.size > 256) inspectCache.clear(); // bounded
}

/**
 * Discover launchable Spring Boot projects under a workspace root: dirs with a
 * pom.xml. Multi-module parents report their runnable children recursively.
 * Excludes dot-dirs, node_modules, target. Returns [{dir, name, isModule}].
 */
// TCP-level "is anything listening on this loopback port" — no HTTP, no CORS
// (browser fetches cannot distinguish CORS-blocked from refused). Resolves
// true on connect, false otherwise; never rejects.
function netConnectProbe(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(400);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

async function discoverSpringBootProjects(rootDir) {
  const absRoot = resolvePath(rootDir);
  const out = [];
  const seen = new Set();
  const push = (dir, name, isModule) => {
    const abs = resolvePath(dir);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ dir: abs, name, isModule });
  };

  // level 0: root itself
  try {
    if (existsSync(join(absRoot, "pom.xml"))) {
      const expanded = expandRunnableModules(absRoot, basename(absRoot), 1);
      if (expanded.length > 0) {
        for (const m of expanded) push(m.dir, m.name, true);
      } else if (findSpringBootMainClass(absRoot)) {
        push(absRoot, basename(absRoot), false);
      }
    }
  } catch { /* unreadable */ }

  // level 1: direct children (independent projects under a repo dir)
  let entries;
  try {
    entries = readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "target") continue;
    const childDir = join(absRoot, e.name);
    if (seen.has(resolvePath(childDir))) continue;
    try {
      if (!existsSync(join(childDir, "pom.xml"))) continue;
    } catch { continue; }
    const expanded = expandRunnableModules(childDir, e.name, 1);
    if (expanded.length > 0) {
      for (const m of expanded) push(m.dir, m.name, true);
    } else if (findSpringBootMainClass(childDir)) {
      push(childDir, e.name, false);
    }
  }
  // Attach each project's profiles + port (cheap config scan, no src walk)
  // so the GUI renders every row's dropdown fully populated on open —
  // no per-row lazy fetch round-trip.
  for (const p of out) {
    try {
      const cfg = parseApplicationConfig(p.dir);
      p.port = cfg.port;
      p.activeProfile = cfg.activeProfile;
      p.profiles = collectSpringProfiles(p.dir);
      // Ports across ALL profiles: base + every profile-specific yml. The GUI
      // probes these to flag "running externally" (e.g. started from IDEA) —
      // a service the ENGINE did not start gets no Stop button, and without
      // this hint the card looks like an ordinary stopped project.
      const portSet = new Set();
      if (cfg.port) portSet.add(cfg.port);
      for (const prof of p.profiles) {
        try {
          for (const root of [
            join(p.dir, "src", "main", "resources", "config"),
            join(p.dir, "src", "main", "resources"),
            join(p.dir, "target", "classes", "config"),
          ]) {
            for (const ext of ["yml", "yaml", "properties"]) {
              const f = join(root, `application-${prof}.${ext}`);
              if (!existsSync(f)) continue;
              const text = readFileSync(f, "utf8");
              const m = text.match(/(?:^\s*port:\s*(\d+))|(?:server\.port\s*=\s*(\d+))/m);
              if (m) { portSet.add(parseInt(m[1] || m[2], 10)); break; }
            }
          }
        } catch { /* unreadable profile config */ }
      }
      p.ports = [...portSet];
      // Server-side port probe (browser fetches cannot distinguish
      // CORS-blocked from connection-refused): a listening port on a
      // project the engine did not start = "running externally" (e.g. IDEA).
      p.externalPort = null;
      for (const port of p.ports) {
        if (port < 1 || port > 65535 || port === 17890) continue;
        try {
          const conn = await netConnectProbe(port);
          if (conn) { p.externalPort = port; break; }
        } catch { /* nothing listening */ }
      }
    } catch {
      p.profiles = [];
    }
  }
  return out;
}

/** Extract <module> entries from a pom (no nested-parent traversal). */
function parseMavenModules(pomText) {
  const modules = [];
  const m = pomText.match(/<modules>([\s\S]*?)<\/modules>/);
  if (m) {
    for (const mm of m[1].matchAll(/<module>([^<]+)</g)) modules.push(mm[1].trim());
  }
  return modules;
}

/**
 * The module dir's pom <dependency> entries that resolve to SIBLING modules
 * in the same reactor (groupId matches the sibling's own groupId AND the
 * artifactId is a sibling artifact). These are the deps a bare `mvn` run in
 * the module dir CANNOT resolve from ~/.m2 unless someone ran mvn install —
 * IDEA resolves them from workspace module outputs instead. Returns
 * [{artifactId, groupId, siblingDir, siblingClasses}] for the ones that are
 * workspace-resolvable (sibling classes exist) and those that are not.
 */
function internalDepsVsSiblings(dir, moduleDirs) {
  const internal = [];
  let pom;
  try {
    pom = readFileSync(join(dir, "pom.xml"), "utf8");
  } catch {
    return internal;
  }
  // sibling identity: artifactId → {groupId, dir}
  const siblings = new Map();
  for (const m of moduleDirs) {
    const id = moduleArtifactId(m);
    if (!id || resolvePath(m) === resolvePath(dir)) continue;
    let gid;
    try {
      const mp = readFileSync(join(m, "pom.xml"), "utf8");
      const g = mp.match(/<groupId>([^<]+)<\/groupId>/);
      gid = g ? g[1].trim() : undefined;
    } catch { /* unreadable */ }
    if (id) siblings.set(id, { groupId: gid, dir: m });
  }
  // scan <dependency> blocks in OUR pom
  for (const block of pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const gid = block[1].match(/<groupId>([^<]+)<\/groupId>/);
    const aid = block[1].match(/<artifactId>([^<]+)<\/artifactId>/);
    if (!gid || !aid) continue;
    const sib = siblings.get(aid[1].trim());
    if (!sib) continue;
    if (sib.groupId && gid[1].trim() !== sib.groupId) continue;
    internal.push({
      artifactId: aid[1].trim(),
      groupId: gid[1].trim(),
      siblingDir: sib.dir,
      siblingClasses: existsSync(join(sib.dir, "target", "classes")),
    });
  }
  return internal;
}

/**
 * The reactor root pom for a module dir: walk up while the parent dir has a
 * pom.xml that lists the child in <modules> (grandparent chains included).
 * Returns the topmost such pom's dir, or undefined when the module is a
 * standalone project. Bounded at 4 hops.
 */
function findReactorRoot(moduleDir) {
  let cur = resolvePath(moduleDir);
  let root;
  for (let i = 0; i < 4; i++) {
    const parent = resolvePath(join(cur, ".."));
    const parentPom = join(parent, "pom.xml");
    if (!existsSync(parentPom)) break;
    try {
      const pp = readFileSync(parentPom, "utf8");
      const childName = basename(cur);
      const listsChild = [...pp.matchAll(/<module>([^<]+)<\/module>/g)]
        .some((m) => resolvePath(join(parent, m[1].trim())) === cur);
      if (!listsChild) break;
      root = parent;
      cur = parent;
    } catch {
      break;
    }
  }
  return root;
}

/**
 * All module dirs in a reactor (recursively expanded from the root pom's
 * <modules>, incl. nested parents), the root itself NOT included.
 */
function collectReactorModules(rootDir) {
  const out = [];
  const walk = (parentDir, depth) => {
    if (depth > 3) return;
    let mods = [];
    try {
      mods = parseMavenModules(readFileSync(join(parentDir, "pom.xml"), "utf8"));
    } catch { return; }
    for (const m of mods) {
      const modDir = join(parentDir, m);
      if (!existsSync(join(modDir, "pom.xml"))) continue;
      out.push(modDir);
      walk(modDir, depth + 1);
    }
  };
  walk(resolvePath(rootDir), 1);
  return out;
}

// 控制服务仅挂载在 DSH 的已认证同源 HTTP/WS 通道。
class ControlServer {
  constructor() {
    this.clients = new Set();
    this.port = null;
    this.wss = null;
    // Set by apply(): { start(args), stop(args) } delegating to the same
    // core functions the agent tools use.
    this.handlers = { start: null, stop: null };
  }

  start(ctx) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    this.wss.on("error", (error) => console.warn("[spring-boot-launcher] WebSocket 错误:", error.message));
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.port = ctx.webServer.port;
    this.disposeTransport = mountControlTransport({
      webServer: ctx.webServer, connection: ctx.connection, wss: this.wss,
      handleRequest: (req, res) => this.handleRequest(req, res),
    });
    console.log("[spring-boot-launcher] control routes mounted on authenticated DSH WebServer");
  }

  snapshotPayload() {
    const services = {};
    for (const [key, entry] of processes) {
      services[key] = {
        projectKey: key,
        running: entry.shellProcess.status === "running",
        status: entry.shellProcess.status,
        port: entry.handle.port,
        mode: entry.handle.mode,
        cmd: entry.handle.cmd,
        logPath: entry.handle.logPath,
        projectDir: entry.projectDir,
        health: entry.handle.health,
        healthReason: entry.handle.healthReason,
        uptimeMs: Date.now() - entry.startedAt,
      };
    }
    return services;
  }

  handleConnection(ws) {
    this.clients.add(ws);
    // Send current state snapshot + recent log tail per service, so a
    // freshly-loaded page (or late panel) sees history, not just the future.
    ws.send(JSON.stringify({ type: "snapshot", services: this.snapshotPayload() }));
    for (const [key, entry] of processes) {
      ws.send(JSON.stringify({
        type: "logSnapshot",
        projectKey: key,
        text: entry.logBuffer.slice(-LOG_SNAPSHOT_CHARS),
      }));
    }
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  /** Inspect handler set by apply(): (dir) → profile (launch facts + profiles list). */
  get inspectHandler() { return this.handlers.inspect; }

  handleRequest(req, res) {
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: SERVICE_MARKER,
        port: this.port,
        services: this.snapshotPayload(),
      }));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/logs")) {
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      const ident = query.get("key") || query.get("dir") || "";
      const lines = Math.max(1, Math.min(
        Number.parseInt(query.get("lines") || "200", 10) || 200, 5000));
      const found = resolveEntry(ident);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!found) {
        res.end(JSON.stringify({ why: "not started" }));
        return;
      }
      const allLines = found.entry.logBuffer.split("\n");
      res.end(JSON.stringify({
        service: SERVICE_MARKER,
        projectKey: found.key,
        status: found.entry.shellProcess.status,
        logs: allLines.slice(-lines).join("\n"),
        totalLines: allLines.length,
      }));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/discover")) {
      // ?dir=<workspace root> → launchable Spring Boot projects under it. The
      // GUI passes each registered workspace path; read-only scan (async:
      // the per-project external-port TCP probes are awaited inside).
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      const dir = query.get("dir") || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!dir) {
        res.end(JSON.stringify({ why: "dir required" }));
        return;
      }
      discoverSpringBootProjects(dir)
        .then((projects) => res.end(JSON.stringify({ root: resolvePath(dir), projects })))
        .catch((e) => res.end(JSON.stringify({ projects: [], why: e.message })));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/inspect")) {
      // ?dir=<project> → launch profile incl. the profiles list for the
      // start panel's dropdown. Read-only, no spawn.
      const query = new URL(req.url, "http://127.0.0.1").searchParams;
      const dir = query.get("dir") || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!dir) {
        res.end(JSON.stringify({ why: "dir required" }));
        return;
      }
      try {
        const result = inspectWithCache(dir);
        if (result.matched) {
          result.projectKey = projectKey(resolvePath(dir));
          result.defaultProfile = result.activeProfile;
        }
        res.end(JSON.stringify(lossless(result)));
      } catch (e) {
        res.end(JSON.stringify({ matched: false, why: e.message }));
      }
      return;
    }

    if (req.method === "POST" && (req.url === "/start" || req.url === "/stop")) {
      readBody(req).then((body) => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch (e) {
          const err = new Error(`invalid JSON body: ${e.message}`);
          err.badRequest = true;
          throw err;
        }
        const handler = req.url === "/start" ? this.handlers.start : this.handlers.stop;
        if (!handler) throw new Error("handler not configured");
        // GUI starts return immediately (no 60s health wait); the agent
        // tool keeps its own detach default. Logs/status stream over WS.
        if (req.url === "/start" && parsed.detach === undefined) parsed.detach = true;
        return handler(parsed);
      }).then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }).catch((e) => {
        if (res.destroyed || res.writableEnded) return;
        // 请求体失败不进入启动处理；错误响应后关闭连接，防止继续上传。
        const statusCode = e.statusCode || (e.badRequest ? 400 : 500);
        if (e.statusCode) {
          res.setHeader('Connection', 'close');
          // 让 HTTP 层完整发送错误响应并正常关闭；立即 destroy 会丢失 413。
          // 不再保存后续字节，最多留一秒排空时间，避免恶意持续上传。
          res.once('finish', () => {
            req.resume();
            const timer = setTimeout(() => req.destroy(), 1000);
            timer.unref();
            req.once('close', () => clearTimeout(timer));
          });
          console.warn(`[spring-boot-launcher] control request rejected: ${statusCode}`);
        }
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  broadcastLog(projectKey, delta) {
    this.broadcast({ type: "log", projectKey, delta });
  }

  broadcastStatus(projectKey, status, port, mode) {
    this.broadcast({ type: "status", projectKey, status, port, mode,
      projectDir: processes.get(projectKey)?.projectDir });
  }

  /** Close the listener so a plugin reload (HMR) frees the port. Idempotent. */
  stop() {
    this.disposeTransport?.();
    this.disposeTransport = null;
    for (const ws of this.clients) ws.terminate();
    try { this.wss?.close(); } catch { /* already closed */ }
    this.wss = null;
    this.port = null;
    this.clients.clear();
  }
}

const controlServer = new ControlServer();

// ─── Start / stop cores ───────────────────────────────────────────────────
// Shared by the spring_boot_start/spring_boot_stop agent tools AND the control
// server's HTTP handlers. Keeping one implementation means the GUI and the
// agent get identical behavior, error codes, and degrade logic.
//
// exec is the DSH tool-execution context (carries an abort signal); the HTTP
// path passes null, so every use must be exec-optional.

// Per-project start mutex: two racing starts (GUI double-click, agent+GUI
// overlap) both passed the ALREADY_RUNNING check before either spawned, so
// the loser must wait instead of spawning a second JVM for the same dir.
const startInflight = new Map();

async function startSpringBootCore(ctx, exec, args) {
  const validationError = validateLaunchArgs(args);
  if (validationError) return {isError:true, error:validationError};
  const dir = resolvePath(args.dir);
  const key = projectKey(dir);

  // 保留最近 100 条已结束记录，运行中项目不参与淘汰。
  const ended = [...processes.entries()].filter(([,entry]) => entry.endedAt)
    .sort((a,b) => b[1].endedAt - a[1].endedAt);
  for (const [oldKey,oldEntry] of ended.slice(99)) {
    closeLog(oldEntry);
    processes.delete(oldKey);
    controlServer.broadcast({type:'removed', projectKey:oldKey});
  }

  const prev = startInflight.get(key);
  if (prev) {
    await prev.catch(() => {});
    // After the winner settles, behave like a normal second start: the
    // service it launched should now answer as ALREADY_RUNNING.
    const existing = processes.get(key);
    if (existing && existing.shellProcess.status === "running") {
      return {
        isError: true,
        error: {
          code: "ALREADY_RUNNING",
          message: `Spring Boot service ${key} was just started (pid ${existing.handle.pid}).`,
        },
      };
    }
    return {
      isError: true,
      error: {
        code: "START_RACE_LOST",
        message: `A concurrent start for ${key} finished; its process did not survive — check spring_boot_logs and retry.`,
      },
    };
  }
  const run = (async () => doStart(ctx, exec, args, dir, key))();
  startInflight.set(key, run);
  try {
    return await run;
  } finally {
    startInflight.delete(key);
  }
}

async function doStart(ctx, exec, args, dir, key) {
  // Reject if already running
  const existing = processes.get(key);
  if (existing && existing.shellProcess.status === "running") {
    return {
      isError: true,
      error: {
        code: "ALREADY_RUNNING",
        message: `Spring Boot service ${key} is already running (pid ${existing.handle.pid}). Use spring_boot_stop first.`,
      },
    };
  }

  // Inspect to get launch facts
  const profile = inspectMavenProject(dir);
  if (!profile.matched) {
    return {
      isError: true,
      error: { code: "NOT_A_SPRING_BOOT_PROJECT", message: profile.why || "no pom.xml" },
    };
  }

  // Pick JDK: prefer JAVA_HOME, else first detected that matches requiredJdk
  const jdks = detectJdkCandidates();
  if (jdks.length === 0) {
    return {
      isError: true,
      error: {
        code: "NO_JDK_FOUND",
        message: "No JDK found. Set JAVA_HOME or install JDK under conventional locations.",
      },
    };
  }
  for (const candidate of jdks) {
    candidate.detectedVersion = await probeJdkVersion(ctx, exec, candidate.path);
  }
  const jdk = selectJdk(jdks, profile.requiredJdk || '8+');
  if (!jdk) return {isError:true, error:{code:'JDK_VERSION_MISMATCH',
    message:`未找到符合 ${profile.requiredJdk || '8+'} 的可确认版本 JDK，请配置 JAVA_HOME。`, candidates:jdks}};
  try { assertSafeCommandValue(jdk.path, 'JDK 路径'); }
  catch (error) { return {isError:true, error:{code:'INVALID_ARGUMENT',message:error.message}}; }

  // Build the command
  const springProfile = args.profile || profile.activeProfile || "";
  const portOverride = args.port || profile.port;
  const extraJvm = args.jvmArgs || "";

  // Construct env with JAVA_HOME pinned
  const env = {
    JAVA_HOME: jdk.path,
  };

  const javaExe = `"${join(jdk.path, "bin", "java.exe")}"`;

  // Launch-mode decision tree. Order: explicit user override > target/jar
  // > noBuild > springBootRunSkipped > default. Returns one of:
  //   dev-run | dev-run-classpath | jar-run | direct-classpath
  // plus reasons[] for diagnostics.
  const pickMode = () => {
    const reasons = [];
    // 1. Explicit user override
    if (args.mode && args.mode !== "auto") {
      reasons.push(`user override: mode=${args.mode}`);
      return { mode: args.mode, reasons };
    }
    // 2. Explicit jarPath
    if (args.jarPath) {
      reasons.push(`user override: jarPath=${args.jarPath}`);
      return { mode: "jar-run", reasons };
    }
    // 3. target/ has a thin-jar (inspect already probed it; also
    // re-probe here in case inspect was skipped — cheap).
    const thinJar = profile.thinJarPath || findThinJar(dir);
    if (thinJar) {
      // Staleness gate: a thin jar is a package-time snapshot. If sources
      // changed after packaging (branch switch, edits), java -jar runs the
      // OLD branch while IDEA (recompiled target/classes) runs the NEW one
      // — observed live as "jar fails, IDEA works" on the same profile.
      // Fresh jar → jar-run. Stale jar → prefer fresh classes if present,
      // else warn and still jar-run (explicit jarPath re-run is available).
      if (profile.thinJarStale === true) {
        reasons.push(
          `thin-jar STALE (built ${new Date(profile.thinJarMtime || 0).toISOString()} < src newest ${new Date(profile.srcNewestMtime || 0).toISOString()}) — running it would execute pre-switch code`
        );
        if (profile.targetClassesExist && profile.targetClassesPopulated && !profile.targetClassesStale && profile.targetLibJars > 0) {
          reasons.push("target/classes is fresher (IDEA-compiled) → direct-classpath");
          return { mode: "direct-classpath", reasons };
        }
        // No fresh classes anywhere: never launch stale bytecode. Compile
        // from source instead (dev-run-classpath runs mvn compile).
        reasons.push("no fresh classes available — dev-run-classpath will mvn-compile fresh classes and refresh target/lib");
        return { mode: "dev-run-classpath", reasons };
      }
      reasons.push(`thin-jar found (fresh) at ${thinJar}`);
      return { mode: "jar-run", reasons };
    }
    // 4. noBuild=true with target/classes present → direct-classpath
    if (args.noBuild && profile.targetClassesExist) {
      reasons.push("noBuild=true and target/classes present");
      return { mode: "direct-classpath", reasons };
    }
    // 5. Workspace-resolution gate — BEFORE any mvn route: internal deps
    //    (sibling reactor modules) missing from ~/.m2 break EVERY mvn
    //    invocation from the module dir (dev-run, dev-run-classpath's
    //    compile+copy-dependencies — observed live as the cloudera/offline
    //    resolution failure on service-api under the crippled
    //    branch). IDEA resolves these from the workspace; we must too,
    //    regardless of which branch would otherwise pick mvn.
    if (profile.internalDepsMissingInM2 && profile.internalDepsMissingInM2.length > 0) {
      const missing = profile.internalDepsMissingInM2.join(", ");
      reasons.push(`mvn would fail: internal deps ${missing} are not in ~/.m2 (never mvn-installed)`);
      // Third-party jars are as essential as sibling classes: a half-cleaned
      // target (mvn failed mid-prepare, assembly dir wiped) leaves
      // direct-classpath with NO jars → NoClassDefFoundError on the very
      // first Spring class. When jars are gone, the reactor prepare
      // (compile + copy-dependencies from the ROOT pom, -pl -am) rebuilds
      // everything AND resolves siblings in-reactor — one mvn run, then the
      // plain java -cp launches.
      const hasThirdPartyJars = profile.targetLibJars > 0 || (profile.assemblyLibJars || 0) > 0;
      if (profile.internalDepsResolvableByWorkspace &&
          profile.targetClassesExist && profile.targetClassesPopulated && hasThirdPartyJars) {
        reasons.push("IDEA-equivalent workspace resolution: sibling target/classes on classpath → direct-classpath");
        return { mode: "direct-classpath", reasons };
      }
      if (!hasThirdPartyJars) {
        reasons.push("third-party jars are ALSO missing (target half-cleaned by a failed mvn prepare) → dev-run-classpath with REACTOR prepare: rebuilds deps from the root pom (-pl -am) so both jars and internal deps come back");
      }
      if (profile.reactorRoot) {
        reasons.push("reactor context: build/resolve from root pom");
        return { mode: "dev-run-classpath", reasons };
      }
      reasons.push(`WARNING: internal deps ${missing} missing from ~/.m2 and no reactor root/workspace classes — mvn will fail on dependency resolution; run "mvn install" on the siblings or open the project in IDEA once`);
    }
    // 6. spring-boot:run not viable: <skip>true</skip> disables it, or
    //    <includes>/<excludes> (jar/dep-separation layout) strips runtime
    //    deps so the forked classpath dies with NoClassDefFoundError.
    if (profile.springBootRunSkipped || profile.springBootRunCrippled) {
      if (profile.springBootRunSkipped) reasons.push("spring-boot:run skipped in POM");
      if (profile.springBootRunCrippled) reasons.push("spring-boot:run crippled by includes/excludes (dep-separation layout — fork classpath would NoClassDefFoundError)");
      if (profile.targetClassesExist && profile.targetClassesPopulated && !profile.targetClassesStale && profile.targetLibJars > 0) {
        reasons.push("fresh target/classes + target/lib present → direct-classpath");
        return { mode: "direct-classpath", reasons };
      }
      if (profile.targetClassesStale) {
        reasons.push("target/classes is STALE (older than sources) — direct-classpath would run old bytecode");
      } else if (profile.targetClassesExist && !profile.targetClassesPopulated) {
        reasons.push("target/classes exists but is EMPTY (clean leftover) — not usable as-is");
      } else {
        reasons.push("no ready artifacts");
      }
      reasons.push("→ dev-run-classpath (mvn compile + copy-dependencies, bypasses spring-boot plugin fork)");
      return { mode: "dev-run-classpath", reasons };
    }
    // 7. Default: dev-run (mvn spring-boot:run)
    reasons.push("default: mvn spring-boot:run");
    // noBuild auto-downgrade: dev-run IS mvn, so noBuild forces
    // downgrade. Pick the lightest non-mvn mode available.
    if (args.noBuild) {
      if (profile.targetClassesExist && profile.targetClassesPopulated && profile.targetLibJars > 0) {
        reasons.push("noBuild downgrade: dev-run → direct-classpath");
        return { mode: "direct-classpath", reasons };
      }
      reasons.push("noBuild downgrade requested but target/classes or target/lib missing — dev-run will run without mvn prepare steps (best-effort)");
      // Fall through to dev-run anyway; agent can re-call with mode=direct-classpath
    }
    return { mode: "dev-run", reasons };
  };

  let { mode, reasons } = pickMode();
  reasons.push("sandbox: danger-full-access (Spring Boot service must write target/, logs/, ~/.m2)");

  // Single command-construction call: all four modes go through
  // buildLaunchCommand; the decision tree only picks the mode label.
  const launch = buildLaunchCommand({
    mode,
    dir,
    profile,
    javaExe,
    argsJarPath: args.jarPath,
    springProfile,
    extraJvm,
    portOverride,
    mvnOffline: args.mvnOffline,
  });
  if (launch.error) {
    return { isError: true, error: launch.error };
  }
  const cmd = wrapForPwshExec(launch.innerCmd);
  if (launch.notes && launch.notes.length) {
    reasons = reasons.concat(launch.notes);
  }
  // Staleness warning catch-all: any path that ends up launching a stale
  // thin jar (explicit mode=jar-run override, explicit jarPath, the degrade
  // fallback) must say so in modeReasons. Deduped against the decision
  // tree's own staleness lines, which already carry the timestamps.
  if (launch.mode === "jar-run" && profile.thinJarStale === true &&
      !reasons.some((r) => r.includes("STALE"))) {
    reasons.push(
      `WARNING: thin-jar is stale (built ${new Date(profile.thinJarMtime || 0).toISOString()}, src newer ${new Date(profile.srcNewestMtime || 0).toISOString()}) — java -jar will run pre-switch code`
    );
  }

  // Start the process via ctx.shell. The explicit sandboxPolicy is the fix
  // for the 拒绝访问 wall: without it the deployment default (read-only /
  // foreign workspaceRoot) confines the JVM, and logback dies opening
  // logs/logback.*.log before the app even boots.
  let shellProc;
  try {
    shellProc = ctx.shell.start(ctx.shell.resolve({
      command: cmd,
      workdir: dir,
      env,
      sandboxPolicy: FULL_ACCESS_POLICY,
    }));
  } catch (e) {
    return {
      isError: true,
      error: {
        code: "SPAWN_FAILED",
        message: `Failed to start process: ${e.message}`,
      },
    };
  }

  const logFile = openLogFile(dir);
  const handle = {
    projectKey: key,
    pid: shellProc.pid ?? null,
    port: portOverride || profile.port,
    healthUrl: portOverride
      ? `http://localhost:${portOverride}/actuator/health`
      : profile.port
        ? `http://localhost:${profile.port}/actuator/health`
        : undefined,
    cmd,
    mode,
    jdkPath: jdk.path,
    modeReasons: reasons,
    logPath: logFile.path,
  };

  const entry = {
    shellProcess: shellProc,
    handle,
    logBuffer: "",
    logFd: logFile.fd,
    startedAt: Date.now(),
    projectDir: dir,
    projectKey: key,
    modeReasons: reasons,
  };
  entry.pumpAbort = new AbortController();
  processes.set(key, entry);
  invalidateInspectCache(dir); // a start mutates target/ the profile reflects

  // Log-polling loop: accumulate (capped) + append to the log file +
  // broadcast over the control server. Reads entry.shellProcess (not a
  // captured variable) so a degraded/restarted process keeps its poller when
  // the loop is re-invoked after the swap.
  const pollLogs = async () => {
    const proc = entry.shellProcess;
    if (entry.logFd === null) entry.logFd = openLogFile(dir).fd;
    entry.endedAt = undefined;
    entry.pump = pumpProcess(proc, {
      signal: entry.pumpAbort.signal,
      append: delta => { appendLog(entry, delta); controlServer.broadcastLog(key, delta); },
      onEnd: status => {
        if (entry.shellProcess !== proc) return;
        entry.endedAt = Date.now();
        closeLog(entry);
        controlServer.broadcastStatus(key, status, entry.handle.port, entry.handle.mode);
        controlServer.broadcast({type:'logEnd', projectKey:key, status});
      },
    });
    return entry.pump;
  };
  pollLogs().catch(error => console.error('[spring-boot-launcher] 日志读取失败', key, error.message));

  // Announce the new service so open GUI panels add it without reconnecting.
  controlServer.broadcastStatus(key, "running", handle.port, mode);

  // If not detach, poll health until ready or timeout
  let healthy = false;
  if (!args.detach) {
    const healthTimeout = 60000; // 60s
    const deadline = Date.now() + healthTimeout;
    let lastError = "";

    while (Date.now() < deadline && shellProc.status === "running") {
      // Check if process died early
      await new Promise((r) => setTimeout(r, 2000));
      if (shellProc.status !== "running") {
        // mvn-fail auto-degrade: if the chosen mode was dev-run (mvn
        // spring-boot:run) and target/ has the artifacts ready, retry once
        // without mvn (direct-classpath, else jar-run).
        if (mode === "dev-run" && !handle._degraded) {
          const hasDirect =
            profile.targetClassesExist && profile.targetClassesPopulated &&
            !profile.targetClassesStale &&
            profile.targetLibJars > 0;
          if (hasDirect) {
            // Degrade to the no-mvn mode when fresh IDEA-compiled classes
            // are ready; when classes are missing/stale the build itself was
            // the problem, so degrading would only relaunch old bytecode.
            const degradeMode = "direct-classpath";
            const degradedLaunch = buildLaunchCommand({
              mode: degradeMode,
              dir,
              profile,
              javaExe,
              argsJarPath: args.jarPath,
              springProfile,
              extraJvm,
              portOverride,
              mvnOffline: args.mvnOffline,
            });
            if (degradedLaunch.error) {
              // Degrade target itself isn't viable — fall through to the
              // original PROCESS_EXITED_EARLY error.
              break;
            }
            const newCmd = wrapForPwshExec(degradedLaunch.innerCmd);
            try {
              const newShellProc = ctx.shell.start(ctx.shell.resolve({
                command: newCmd,
                workdir: dir,
                env,
                sandboxPolicy: FULL_ACCESS_POLICY,
              }));
              // Swap the entry's process + handle, keep the log buffer and
              // the open log file fd (same project, append continues).
              entry.shellProcess = newShellProc;
              entry.handle = {
                ...handle,
                mode: `${degradeMode} (degraded from dev-run)`,
                cmd: newCmd,
                health: "retrying",
              };
              // Rebind the health-check loop to the new process and restart
              // the log poller (the old loop exited when proc #1 died).
              shellProc = newShellProc;
              entry.modeReasons = [
                ...(entry.modeReasons || []),
                `dev-run failed; degraded to ${degradeMode} after ${Math.round((Date.now() - entry.startedAt) / 1000)}s`,
              ];
              handle.mode = entry.handle.mode;
              handle._degraded = true;
              pollLogs().catch(() => {});
              controlServer.broadcastStatus(key, "running", entry.handle.port, entry.handle.mode);
              continue; // re-enter the health-check loop with new proc
            } catch (e) {
              closeLog(entry);
              return {
                isError: true,
                error: {
                  code: "PROCESS_EXITED_EARLY",
                  message: earlyExitMessage(entry, "dev-run, degrade attempt failed: " + e.message),
                },
              };
            }
          }
        }
        // Original PROCESS_EXITED_EARLY path (no degrade applicable)
        closeLog(entry);
        return {
          isError: true,
          error: {
            code: "PROCESS_EXITED_EARLY",
            message: earlyExitMessage(entry, mode),
          },
        };
      }
      // Try health check if we have a port — plain fetch, no pwsh spawn.
      if (handle.healthUrl) {
        try {
          const result = await checkHealth(handle.healthUrl);
          entry.handle.healthReason = result.reason;
          lastError = result.reason;
          if (result.healthy) {
            healthy = true;
            break;
          }
        } catch (e) {
          lastError = e.message;
        }
      } else {
        // No port — check log for "Started" or "Tomcat started"
        if (/Started\s+\w+Application|Tomcat started on port|Started Application/i.test(entry.logBuffer)) {
          healthy = true;
          break;
        }
      }
    }

    if (!healthy && shellProc.status === "running" && lastError) {
      entry.handle.modeReasons = [
        ...(entry.handle.modeReasons || []),
        `health check not confirmed within ${Math.round(healthTimeout / 1000)}s (last error: ${lastError})`,
      ];
    }
  }

  // Instant-death guard: a process that was already dead when the health loop
  // first looked never entered the loop, and without this check the tool would
  // return a "successful" handle with health "exited" (the false-success trap
  // seen in the wild — e.g. logback dying before Spring boots).
  //
  // STALE-LIB degrade runs REGARDLESS of detach (the GUI always starts
  // detached; a stale packaged lib is a build problem the user cannot see —
  // silently returning "started (exited)" would just puzzle them). Both the
  // degrade and the honest error apply ONLY to a non-running process; a live
  // process must fall through to the normal finalHandle below.
  if (shellProc.status !== "running" && !healthy) {
    const diedOnMissingClass =
      /NoClassDefFoundError|ClassNotFoundException/.test(entry.logBuffer);
    if ((mode === "direct-classpath" || mode === "jar-run") &&
        diedOnMissingClass && profile.reactorRoot && !handle._degraded) {
      handle._degraded = true;
      const rebuiltLaunch = buildLaunchCommand({
        mode: "dev-run-classpath",
        dir, profile, javaExe,
        argsJarPath: args.jarPath, springProfile, extraJvm, portOverride,
        mvnOffline: args.mvnOffline,
      });
      if (!rebuiltLaunch.error) {
        const newCmd = wrapForPwshExec(rebuiltLaunch.innerCmd);
        try {
          const rebuiltProc = ctx.shell.start(ctx.shell.resolve({
            command: newCmd, workdir: dir, env, sandboxPolicy: FULL_ACCESS_POLICY,
          }));
          entry.shellProcess = rebuiltProc;
          entry.handle = { ...handle, mode: "dev-run-classpath (rebuilt stale lib)", cmd: newCmd, health: "retrying" };
          entry.modeReasons = [
            ...(entry.modeReasons || []),
            "classpath died on a missing class → packaged lib is STALE (older than the pom's deps); rebuilt deps via reactor prepare and retried",
          ];
          shellProc = rebuiltProc;
          pollLogs().catch(() => {});
          controlServer.broadcastStatus(key, "running", entry.handle.port, entry.handle.mode);
          // second health wait, bounded: the reactor prepare can take minutes
          // (compile + copy-dependencies), so allow a generous window and
          // return running-state even if health never confirms (the process
          // is up; logs stream to the GUI meanwhile). Env-overridable for
          // tests (the default would blow test timeouts).
          const rebuildWaitMs = Number.parseInt(process.env.DSH_REBUILD_WAIT_MS || "", 10) || 300000;
          const deadline2 = Date.now() + rebuildWaitMs;
          while (Date.now() < deadline2 && shellProc.status === "running") {
            await new Promise((r) => setTimeout(r, 2000));
            if (shellProc.status !== "running") break;
            if (handle.healthUrl) {
              try {
                const result = await checkHealth(handle.healthUrl);
                entry.handle.healthReason = result.reason;
                if (result.healthy) { healthy = true; break; }
              } catch { /* keep waiting */ }
            } else if (/Started\s+\w+Application|Tomcat started on port/i.test(entry.logBuffer)) {
              healthy = true; break;
            }
          }
          const rebuiltHandle = entry.handle;
          rebuiltHandle.status = shellProc.status;
          rebuiltHandle.uptimeMs = Date.now() - entry.startedAt;
          rebuiltHandle.healthy = healthy;
          rebuiltHandle.health = healthy ? "healthy" : shellProc.status === "running" ? "not-confirmed" : "exited";
          rebuiltHandle.pid = shellProc.pid ?? null;
          if (shellProc.status !== "running") { await entry.pump; closeLog(entry); }
          controlServer.broadcastStatus(key, rebuiltHandle.status, rebuiltHandle.port, rebuiltHandle.mode);
          return rebuiltHandle;
        } catch {
          /* fall through to the honest error below */
        }
      }
    }
    await entry.pump;
    closeLog(entry);
    return {
      isError: true,
      error: { code: "PROCESS_EXITED_EARLY", message: earlyExitMessage(entry, mode) },
    };
  }

  const finalHandle = entry.handle;
  finalHandle.status = shellProc.status;
  finalHandle.uptimeMs = Date.now() - entry.startedAt;
  finalHandle.healthy = healthy;
  finalHandle.health = healthy
    ? "healthy"
    : shellProc.status === "running"
      ? (args.detach ? "detached" : handle.healthUrl ? "not-confirmed" : "no-port-log-match")
      : "exited";
  finalHandle.pid = shellProc.pid ?? null;
  controlServer.broadcastStatus(key, finalHandle.status, finalHandle.port, finalHandle.mode);
  return finalHandle;
}

async function stopSpringBootCore(ctx, dirOrKey) {
  const found = resolveEntry(dirOrKey);
  if (!found) {
    return { projectKey: String(dirOrKey), stopped: false, why: "not running" };
  }
  const { key, entry } = found;
  const wasRunning = entry.shellProcess.status === "running";
  if (wasRunning) {
    // Graceful-first, force-second — mirrors IDEA's stop. `taskkill /T` (no
    // /F) posts WM_CLOSE to the tree; the JVM runs its shutdown hooks so
    // Spring's Stopping logs actually emit. /F would kill the instant the
    // button is clicked, and those "为什么结束日志没滚动" shutdown lines would
    // never exist. Fall back to /F only when graceful didn't settle.
    const pid = entry.shellProcess.pid ?? entry.handle.pid;
    const waitForExit = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && entry.shellProcess.status === "running") {
        await new Promise((r) => setTimeout(r, 150));
      }
      return entry.shellProcess.status !== "running";
    };
    if (pid && ctx?.shell) {
      try {
        await ctx.shell.run(ctx.shell.resolve({
          command: `cmd.exe /c "taskkill /T /PID ${pid}"`,
          timeoutMs: 10000,
          sandboxPolicy: FULL_ACCESS_POLICY,
        }));
      } catch {
        /* graceful signal failed — force path below */
      }
    } else {
      entry.shellProcess.kill();
    }
    // Grace window: give shutdown hooks time to emit their logs while the
    // poller (300ms cadence) keeps streaming them.
    const exitedGracefully = await waitForExit(8000);
    if (!exitedGracefully) {
      entry.shellProcess.kill();
      if (pid && ctx?.shell) {
        try {
          await ctx.shell.run(ctx.shell.resolve({
            command: `cmd.exe /c "taskkill /F /T /PID ${pid}"`,
            timeoutMs: 10000,
            sandboxPolicy: FULL_ACCESS_POLICY,
          }));
        } catch {
          /* best-effort; the direct kill above already ran */
        }
      }
      await waitForExit(2000);
    }
  }
  // Keep streaming until the shell settles so the final drain lands in both
  // the buffer and the log file, THEN close. The status broadcast follows.
  if (entry.shellProcess.status !== 'running') {
    await entry.pump;
    closeLog(entry);
  }
  const finalStatus = entry.shellProcess.status;
  controlServer.broadcastStatus(key, finalStatus, entry.handle.port, entry.handle.mode);
  return {
    projectKey: key,
    stopped: finalStatus !== 'running',
    wasRunning,
    finalStatus,
    exitCode: entry.shellProcess.exitCode,
    uptimeMs: Date.now() - entry.startedAt,
  };
}

// ─── Plugin definition ────────────────────────────────────────────────────

const name = "spring-boot-launcher";
const inject = ["tools", "shell"];
const description =
  "Manage Maven Spring Boot service processes: inspect, start, status, logs, stop. " +
  "Validated on Windows. " +
  "Uses ctx.shell for process management; streams logs/status to the GUI " +
  "control server, which delegates to the same core functions as these tools.";

function apply(ctx) {
  // Control server for the GUI panel. HTTP start/stop delegate to the same
  // cores as the agent tools, so both entries share one engine.
  controlServer.handlers = {
    start: async (args) => lossless(await startSpringBootCore(ctx, null, args)),
    stop: async (args) => lossless(await stopSpringBootCore(ctx, args.key || args.dir)),
  };
  // Agent-only 组合不开放网络入口。Web 服务随原生认证依赖一起挂载和释放。
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer", "connection"], (webCtx) => {
      controlServer.start(webCtx);
      webCtx.on("dispose", () => controlServer.stop());
    });
  } else if (ctx.webServer && ctx.connection) {
    controlServer.start(ctx);
  }

  // On plugin teardown (HMR reload / composition dispose): free the control
  // port and close log fds. The child processes themselves are owned by
  // ctx.subprocess and follow its disposal.
  ctx.on("dispose", () => {
    for (const [, entry] of processes) { entry.pumpAbort?.abort(); closeLog(entry); }
    controlServer.stop();
  });

  // ── spring_boot_inspect ──
  ctx.tools.register(
    defineTool({
      name: "spring_boot_inspect",
      description:
        "Inspect a Maven Spring Boot project directory and return a structured launch " +
        "profile (build tool, Spring Boot version, required JDK, main class, " +
        "port, recommended run mode, detected JDKs with versions). " +
        "Maven/Spring Boot only in this phase.",
      parameters: {
        dir: {
          type: "string",
          required: true,
          description:
            "Absolute path to the Spring Boot project root (directory with pom.xml).",
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
      },
      async execute(args, exec) {
        const result = inspectMavenProject(args.dir);
        if (result.matched) {
          const jdks = detectJdkCandidates();
          for (const j of jdks) {
            j.detectedVersion = await probeJdkVersion(ctx, exec, j.path);
          }
          result.detectedJdks = jdks;
          result.projectKey = projectKey(args.dir);
        }
        return lossless(result);
      },
    })
  );

  // ── spring_boot_start ──
  ctx.tools.register(
    defineTool({
      name: "spring_boot_start",
      description:
        "Start a Maven Spring Boot service: pin JDK, compile, launch, poll health, stream logs. " +
        "Auto mode adapts to the project state and is IDEA-equivalent: internal deps " +
        "missing from ~/.m2 are resolved from sibling workspace classes (or built " +
        "from the reactor root with -pl/-am); stale artifacts never run (mvn compile " +
        "from source instead); third-party jars are found in target/lib OR assembly " +
        "layouts (target/*/lib); src/main/resources joins the classpath when " +
        "target/classes holds a partial config copy. modeReasons always explains " +
        "the choice. Returns {projectKey, pid, port, health, healthy, cmd, mode, logPath}. " +
        "Use spring_boot_status/logs/stop to manage.",
      parameters: {
        dir: {
          type: "string",
          required: true,
          description: "Absolute path to the Spring Boot project root.",
        },
        profile: {
          type: "string",
          description:
            "Spring profile to activate (e.g. 'dev', 'local'). Optional.",
        },
        jvmArgs: {
          type: "string",
          description:
            "Extra JVM args, space-separated (e.g. '-Xmx2g -Dfile.encoding=UTF-8'). Optional.",
        },
        port: {
          type: "integer",
          description: "Override server.port. Optional.",
        },
        build: {
          type: "boolean",
          description:
            "If true, run mvn compile before launch (default true for first start).",
        },
        mode: {
          type: "string",
          description:
            "Launch mode. auto (default) runs the detection tree; " +
            "dev-run | dev-run-classpath | jar-run | direct-classpath force a specific mode. " +
            "Forcing dev-run on a project without mvn available will fail.",
        },
        jarPath: {
          type: "string",
          description:
            "Absolute path to a pre-built jar. When set, forces jar-run mode " +
            "and skips thin-jar detection. Use when target/ has the right jar " +
            "but findThinJar's heuristics miss it.",
        },
        noBuild: {
          type: "boolean",
          description:
            "Skip mvn prepare steps (process-resources, copy-dependencies). " +
            "In dev-run this auto-downgrades to dev-run-classpath or direct-classpath " +
            "(dev-run IS mvn). Has no effect on jar-run.",
        },
        mvnOffline: {
          type: "boolean",
          description:
            "Pass -o (offline) to mvn so it uses only ~/.m2/repository and " +
            "doesn't try to reach internal mirrors (e.g. nexus). Default true. " +
            "Set to false to force online mode. Only affects modes that invoke mvn " +
            "(dev-run, dev-run-classpath).",
        },
        detach: {
          type: "boolean",
          description:
            "If true, return immediately without waiting for health. Default false.",
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
      },
      async execute(args, exec) {
        return lossless(await startSpringBootCore(ctx, exec, args));
      },
    })
  );

  // ── spring_boot_status ──
  ctx.tools.register(
    defineTool({
      name: "spring_boot_status",
      description:
        "Check the status of a running Spring Boot service. Returns running/pid/port/uptime/health. " +
        "If no dir given, lists all known Spring Boot services.",
      parameters: {
        dir: {
          type: "string",
          description:
            "Absolute path to the Spring Boot project root (projectKey also accepted). If omitted, lists all services.",
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
      },
      async execute(args) {
        if (!args.dir) {
          const all = [];
          for (const [key, entry] of processes) {
            all.push({
              projectKey: key,
              status: entry.shellProcess.status,
              running: entry.shellProcess.status === "running",
              port: entry.handle.port,
              logPath: entry.handle.logPath,
              uptimeMs: Date.now() - entry.startedAt,
              cmd: entry.handle.cmd,
            });
          }
          return lossless({ services: all });
        }
        const found = resolveEntry(args.dir);
        if (!found) {
          return lossless({ projectKey: projectKey(resolvePath(args.dir)), running: false, why: "not started" });
        }
        const { key, entry } = found;
        return lossless({
          projectKey: key,
          running: entry.shellProcess.status === "running",
          status: entry.shellProcess.status,
          exitCode: entry.shellProcess.exitCode,
          pid: entry.handle.pid,
          port: entry.handle.port,
          uptimeMs: Date.now() - entry.startedAt,
          mode: entry.handle.mode,
          jdkPath: entry.handle.jdkPath,
          cmd: entry.handle.cmd,
          logPath: entry.handle.logPath,
          logBytes: entry.logBuffer.length,
        });
      },
    })
  );

  // ── spring_boot_logs ──
  ctx.tools.register(
    defineTool({
      name: "spring_boot_logs",
      description:
        "Read Spring Boot service logs. Returns a snapshot of recent log output. " +
        "For continuous log following, the GUI panel streams via the control " +
        "server WebSocket. Use lines to limit output (default 100 tail lines).",
      parameters: {
        dir: {
          type: "string",
          required: true,
          description:
            "Absolute path to the Spring Boot project root (projectKey also accepted).",
        },
        lines: {
          type: "integer",
          description: "Number of tail lines to return (default 100).",
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_a, v) => [{ type: "text", text: v.logs || JSON.stringify(v) }],
      },
      async execute(args) {
        const found = resolveEntry(args.dir);
        if (!found) {
          return lossless({ projectKey: projectKey(resolvePath(args.dir)), logs: "", why: "not started" });
        }
        const { key, entry } = found;
        const lineCount = args.lines || 100;
        const lines = entry.logBuffer.split("\n");
        const tail = lines.slice(-lineCount).join("\n");
        return lossless({
          projectKey: key,
          status: entry.shellProcess.status,
          logs: tail,
          totalLines: lines.length,
          logPath: entry.handle.logPath,
        });
      },
    })
  );

  // ── spring_boot_stop ──
  ctx.tools.register(
    defineTool({
      name: "spring_boot_stop",
      description:
        "Stop a running Spring Boot service. Kills the shell process; on Windows " +
        "also attempts a taskkill /T tree-kill so the JVM grandchild dies too.",
      parameters: {
        dir: {
          type: "string",
          required: true,
          description:
            "Absolute path to the Spring Boot project root (projectKey also accepted).",
        },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }],
      },
      async execute(args) {
        return lossless(await stopSpringBootCore(ctx, args.dir));
      },
    })
  );
}

export { apply, inject, name };
