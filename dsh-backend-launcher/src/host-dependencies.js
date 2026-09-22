import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dshHome =
  process.env.DSH_HOME ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
// DSH deployments disagree on where a host plugin can resolve bare deps from:
// DSH_HOME may be the ~/.dsh root (flat profiles/node_modules healing dir) or
// a concrete profile dir (e.g. ~/.dsh/profiles/web with its own node_modules).
// Probe each candidate and use the first that actually resolves the package —
// see CONTRIBUTING.md ("跨盘符 ESM bare import 陷阱").
const moduleRootCandidates = [
  join(dshHome, "profiles", "node_modules"),
  join(dshHome, "node_modules"),
  join(dshHome, "profiles", "web", "node_modules"),
  dshHome,
];
function resolveFromCandidates(pkgName) {
  for (const root of moduleRootCandidates) {
    try {
      const req = createRequire(join(root, "dummy.cjs"));
      return { req, entryPath: req.resolve(pkgName) };
    } catch {
      /* try the next candidate root */
    }
  }
  throw new Error(
    `dsh-spring-boot-launcher: cannot resolve "${pkgName}" from any of: ${moduleRootCandidates.join(", ")}`
  );
}
const dshTools = resolveFromCandidates("@deepseek-ai/dsh-tools");
export const { defineTool } = await import(pathToFileURL(dshTools.entryPath).href);
// ws (WebSocket) lives beside dsh-tools — but not necessarily in the same
// root, so resolve it through its own candidate probe.
const { req: requireWs } = resolveFromCandidates("ws");
export const { WebSocketServer } = requireWs("ws");
