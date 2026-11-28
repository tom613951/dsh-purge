import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import {
  findDshHome,
  defaultOverrideText,
  hangOperatorPrompt,
  hungOperatorPrompt,
  normalizeOverride,
  peekCommittedOverride,
  readPromptInjectFileSync,
  hashOverride,
  defaultOverrideHash,
  atomicWriteFile,
} from "./core.js";

export const WORKSPACE_POLICIES = ["fallback", "strict", "always"];
const DEFAULT_WORKSPACE_POLICY = "fallback";

export { findDshHome };

function purgeStateDir(dshHome) {
  return path.join(dshHome, "dsh-purge");
}

function workspacePolicyPath(dshHome) {
  return path.join(purgeStateDir(dshHome), "workspace-policy.json");
}

function lastCwdPath(dshHome) {
  return path.join(purgeStateDir(dshHome), "last-cwd.txt");
}

/**
 * 唯一注入源解析：
 * 本进程框内提交 > $DSH_HOME/prompt-inject.md > 加密槽。
 */
export function resolveInjectText(dshHome) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  const pinned = peekCommittedOverride(home);
  if (typeof pinned === "string" && normalizeOverride(pinned)) {
    return { text: normalizeOverride(pinned), source: "prompt", ruleId: null };
  }
  const diskNorm = normalizeOverride(readPromptInjectFileSync(home));
  if (diskNorm) {
    const source = hashOverride(diskNorm) === defaultOverrideHash() ? "default" : "prompt";
    return { text: diskNorm, source, ruleId: null };
  }
  const bundled = normalizeOverride(defaultOverrideText());
  if (bundled) return { text: bundled, source: "default", ruleId: null };
  return { text: "", source: "none", ruleId: null };
}

/** 组装前挂上操作者正文（prompt-inject.md / 框内提交 / 加密槽）。 */
export function ensureOperatorBody(dshHome) {
  const resolved = resolveInjectText(dshHome);
  if (resolved.text) hangOperatorPrompt(resolved.text);
  return resolved.text || normalizeOverride(hungOperatorPrompt()) || "";
}

export function readWorkspacePolicy(dshHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspacePolicyPath(dshHome), "utf8"));
    const policy = parsed?.policy;
    if (typeof policy === "string" && WORKSPACE_POLICIES.includes(policy)) return policy;
  } catch { /* ignore */ }
  return DEFAULT_WORKSPACE_POLICY;
}

export async function writeWorkspacePolicy(dshHome, policy) {
  if (!WORKSPACE_POLICIES.includes(policy)) {
    throw new Error(`invalid workspace policy: ${policy}`);
  }
  const fp = workspacePolicyPath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, JSON.stringify({ policy }, null, 2));
  return policy;
}

export function writeLastCwd(dshHome, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return;
  try {
    const fp = lastCwdPath(dshHome);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, cwd.trim(), "utf8");
  } catch { /* ignore */ }
}
