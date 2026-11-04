// 插件运行时动态微调配置（tuning.json）。
// 独立于宿主 profile 配置文件，切换无需重启或重载 profile。
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";
import { logAudit } from "./audit.js";

export const TUNING_FILE = "tuning.json";

export const TUNING_DEFAULTS = Object.freeze({
  boost: true, // 尾部强化段
  injectPosition: "head", // head | tail | both
  refusalRetry: true, // 拒答拦截与单次加固重试
  refusalScrubbing: true, // 多轮历史拒答惯性清洗
  excludePresets: [], // 排除在注入之外的预设列表
});

function tuningPath(dshHome) {
  const home = dshHome || findDshHome();
  if (!home) return "";
  return path.join(home, "dsh-purge", TUNING_FILE);
}

export function readTuning(dshHome) {
  const file = tuningPath(dshHome);
  if (!file) return { ...TUNING_DEFAULTS, excludePresets: [] };
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    saved = {};
  }
  const merged = { ...TUNING_DEFAULTS, ...saved };
  if (!["head", "tail", "both"].includes(merged.injectPosition)) {
    merged.injectPosition = TUNING_DEFAULTS.injectPosition;
  }
  merged.boost = typeof merged.boost === "boolean" ? merged.boost : TUNING_DEFAULTS.boost;
  merged.refusalRetry = typeof merged.refusalRetry === "boolean" ? merged.refusalRetry : TUNING_DEFAULTS.refusalRetry;
  merged.refusalScrubbing =
    typeof merged.refusalScrubbing === "boolean" ? merged.refusalScrubbing : TUNING_DEFAULTS.refusalScrubbing;
  merged.excludePresets = Array.isArray(merged.excludePresets)
    ? merged.excludePresets.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean)
    : [];
  return merged;
}

export function writeTuning(patch = {}, dshHome) {
  const file = tuningPath(dshHome);
  if (!file) throw new Error("未定位 DSH 数据目录，无法保存 tuning");
  const before = readTuning(dshHome);
  const next = { ...before, ...patch };
  if (!["head", "tail", "both"].includes(next.injectPosition)) {
    next.injectPosition = before.injectPosition;
  }
  if (patch.excludePresets !== undefined) {
    next.excludePresets = Array.isArray(patch.excludePresets)
      ? patch.excludePresets.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean)
      : before.excludePresets;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  const effective = readTuning(dshHome);

  for (const key of Object.keys(TUNING_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && JSON.stringify(before[key]) !== JSON.stringify(effective[key])) {
      logAudit("tuning_setting", { key, from: before[key], to: effective[key] }, path.dirname(path.dirname(file)));
    }
  }
  return effective;
}
