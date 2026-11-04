// 宿主补丁动态重锚与本地覆盖（Anchor Overrides）：
// 宿主升级导致代码行或锚点微调时，允许将真实代码片段钉为本地覆盖，
// 无需侵入修改插件源码，换版本后随时可撤销。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const OVERRIDES_FILE = "anchor-overrides.json";

function dshHome(explicit) {
  if (explicit) return explicit;
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) return env;
  return path.join(os.homedir(), ".dsh");
}

function overridesPath(explicit) {
  const home = dshHome(explicit);
  if (!home) return "";
  return path.join(home, "dsh-purge", OVERRIDES_FILE);
}

export function readOverrides(explicit) {
  const fp = overridesPath(explicit);
  if (!fp) return {};
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function writeOverride(explicit, patchId, index, pattern, extra = {}) {
  const fp = overridesPath(explicit);
  if (!fp) throw new Error("未定位 DSH 数据目录，无法保存重锚覆盖");
  const all = readOverrides(explicit);
  const key = String(patchId);
  all[key] = all[key] || {};
  all[key][String(index)] = {
    pattern,
    at: new Date().toISOString(),
    ...extra,
  };
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fp, JSON.stringify(all, null, 2), { mode: 0o600 });
  return all;
}

export function clearOverride(explicit, patchId, index) {
  const all = readOverrides(explicit);
  const key = String(patchId);
  if (!all[key]) return all;
  if (index === undefined) delete all[key];
  else delete all[key][String(index)];
  if (all[key] && Object.keys(all[key]).length === 0) delete all[key];
  const fp = overridesPath(explicit);
  if (fp) {
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fp, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
  return all;
}

/** 将本地覆盖叠加到补丁对象的 replacements 上（纯函数，不修改原补丁对象）。 */
export function applyOverrides(patch, overrides) {
  const all = overrides || {};
  const mine = all[String(patch && patch.id)];
  if (!mine) return patch;
  const list = Array.isArray(patch.replacements)
    ? patch.replacements.slice()
    : (patch.patterns ?? []).map((pat) => ({ pattern: pat, replace: patch.replace }));
  let changed = false;
  for (const [index, entry] of Object.entries(mine)) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) continue;
    if (!entry || typeof entry.pattern !== "string" || !entry.pattern) continue;
    list[i] = { ...list[i], pattern: entry.pattern };
    changed = true;
  }
  if (!changed) return patch;
  return { ...patch, replacements: list, overridden: true };
}
