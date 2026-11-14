// 插件运行时动态微调配置（tuning.json）。
// 独立于宿主 profile 配置文件，切换无需重启或重载 profile。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync, findDshHome } from "./core.js";
import { logAudit } from "./audit.js";

export const TUNING_FILE = "tuning.json";

export const TUNING_DEFAULTS = Object.freeze({
  boost: true, // 尾部强化段
  injectPosition: "head", // head | tail | both
  refusalRetry: true, // 拒答拦截与多阶段加固重试
  refusalDecompose: true, // 三段式兜底：拆解为最小可交付组件
  refusalScrubbing: true, // 多轮历史拒答惯性清洗
  safetyFilter: true, // 自动剥离宿主纯安全/合规段
  anchorMode: "full", // full | compact | off
  excludePresets: [], // 排除在注入之外的预设列表
});

const BOOLEAN_KEYS = Object.freeze([
  "boost",
  "refusalRetry",
  "refusalDecompose",
  "refusalScrubbing",
  "safetyFilter",
]);

function tuningPath(dshHome) {
  const home = dshHome || findDshHome();
  if (!home) return "";
  return path.join(home, "dsh-purge", TUNING_FILE);
}

function tuningError(file, reason) {
  const err = new Error(`tuning 配置不可读或已损坏 (${path.basename(file)}): ${reason}`);
  err.code = "TUNING_UNREADABLE";
  return err;
}

function normalizeExcludePresets(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function normalizeTuning(saved) {
  const merged = { ...TUNING_DEFAULTS, ...saved };
  if (!["head", "tail", "both"].includes(merged.injectPosition)) {
    merged.injectPosition = TUNING_DEFAULTS.injectPosition;
  }
  if (!["full", "compact", "off"].includes(merged.anchorMode)) {
    merged.anchorMode = TUNING_DEFAULTS.anchorMode;
  }
  for (const key of BOOLEAN_KEYS) {
    merged[key] = typeof merged[key] === "boolean" ? merged[key] : TUNING_DEFAULTS[key];
  }
  merged.excludePresets = normalizeExcludePresets(merged.excludePresets, []);
  return merged;
}

export function readTuning(dshHome) {
  const file = tuningPath(dshHome);
  if (!file) return { ...TUNING_DEFAULTS, excludePresets: [] };

  let lstat;
  try {
    lstat = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch (e) {
    throw tuningError(file, e?.code || "状态检查失败");
  }
  if (!lstat) return { ...TUNING_DEFAULTS, excludePresets: [] };

  if (lstat.isSymbolicLink()) {
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      throw tuningError(file, e?.code ? `符号链接不可访问 (${e.code})` : "悬空符号链接");
    }
    if (!st.isFile()) throw tuningError(file, "符号链接目标不是普通文件");
  } else if (!lstat.isFile()) {
    throw tuningError(file, "目标不是普通文件");
  }

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw tuningError(file, e?.code || "读取失败");
  }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    throw tuningError(file, "JSON 格式无效");
  }

  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw tuningError(file, "配置根节点必须是 JSON 对象");
  }

  return normalizeTuning(saved);
}

export function writeTuning(patch = {}, dshHome) {
  const file = tuningPath(dshHome);
  if (!file) throw new Error("未定位 DSH 数据目录，无法保存 tuning");
  const before = readTuning(dshHome);
  const next = { ...before, ...patch };
  if (!["head", "tail", "both"].includes(next.injectPosition)) {
    next.injectPosition = before.injectPosition;
  }
  if (!["full", "compact", "off"].includes(next.anchorMode)) {
    next.anchorMode = before.anchorMode;
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof next[key] !== "boolean") next[key] = before[key];
  }
  if (patch.excludePresets !== undefined) {
    next.excludePresets = Array.isArray(patch.excludePresets)
      ? normalizeExcludePresets(patch.excludePresets, before.excludePresets)
      : before.excludePresets;
  }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lstat = fs.lstatSync(file, { throwIfNoEntry: false });
  const target = lstat && lstat.isSymbolicLink() ? fs.realpathSync(file) : file;
  atomicWriteSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8", { mode: 0o600 });
  const effective = readTuning(dshHome);

  for (const key of Object.keys(TUNING_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && JSON.stringify(before[key]) !== JSON.stringify(effective[key])) {
      logAudit("tuning_setting", { key, from: before[key], to: effective[key] }, path.dirname(dir));
    }
  }
  return effective;
}
