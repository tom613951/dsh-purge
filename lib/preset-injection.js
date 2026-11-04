// 预设细粒度按需隔离（Preset Injection Isolation）：
// 允许将特定模式（如 roleplay、minimal、代码审查等）排除在破甲提示词注入之外，
// 保留工具放行与底层补丁，避免业务会话被破坏。
import { readTuning } from "./tuning.js";

/** 归一化排除的预设 ID 列表。 */
export function excludedPresetIds(config, dshHome) {
  let list = [];
  if (Array.isArray(config?.excludePresets)) {
    list = config.excludePresets;
  } else {
    try {
      const tuning = readTuning(dshHome);
      if (Array.isArray(tuning.excludePresets)) list = tuning.excludePresets;
    } catch {
      list = [];
    }
  }
  return list
    .filter((x) => typeof x === "string")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** 从会话上下文中提取当前使用的 preset 名称。 */
export function sessionAgentPreset(context) {
  if (!context || typeof context !== "object") return "";
  try {
    const raw =
      context.preset ||
      context.agent?.preset ||
      context.session?.preset ||
      context.agent?.session?.header?.preset ||
      context.agent?.session?.preset ||
      "";
    return String(raw || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/** 判定当前上下文是否允许注入。 */
export function injectionPolicy(config, context, dshHome) {
  const ids = excludedPresetIds(config, dshHome);
  const preset = sessionAgentPreset(context);
  const excluded = Boolean(preset && ids.includes(preset));
  const allowed = config?.enabled !== false && !excluded;
  return { preset, excluded, allowed };
}
