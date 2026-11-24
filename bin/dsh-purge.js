#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as reapply from "../lib/reapply.js";
import fs from "node:fs";
import path from "node:path";
import { findDesktopAppExecutable } from "../lib/desktop.js";
import { readTuning, writeTuning, TUNING_DEFAULTS } from "../lib/tuning.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  let tuning = { ...TUNING_DEFAULTS };
  let tuningErr = null;
  try { tuning = readTuning(state.dsh_home); } catch (e) { tuningErr = e; }
  if (tuningErr) {
    out.push(`  ⚠ 微调配置错误        ${tuningErr.message || tuningErr}`);
  }
  out.push(`  强化段 / boost       ${tuning.boost ? "开启 / on" : "关闭 / off"}`);
  out.push(`  注入位置 / position   ${tuning.injectPosition}`);
  out.push(`  拒答拦截 / retry      ${tuning.refusalRetry ? "开启 / on" : "关闭 / off"}`);
  out.push(`  组件拆解 / decompose  ${tuning.refusalDecompose !== false ? "开启 / on" : "关闭 / off"}`);
  out.push(`  多轮清洗 / scrubbing  ${tuning.refusalScrubbing !== false ? "开启 / on" : "关闭 / off"}`);
  if (tuning.excludePresets?.length) {
    out.push(`  排除预设 / excluded   ${tuning.excludePresets.join(", ")}`);
  }
  if (state.asar_still_sealed) {
    out.push("  ⚠ app.asar      还在。补丁写在解开目录，当前进程读不到");
  }
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`
    + (state.patches_drifted ? `, ${state.patches_drifted} 漂移（官方原文已改，需更新 pattern）` : ""));
  if (state.host_version) {
    const compat = state.host_supported === false ? `  ← 未适配：插件声明 ${state.host_target || "?"}` : "";
    out.push(`  宿主版本 / host  ${state.host_version}${compat}`);
  }
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : s === "drifted" ? "!" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--status", "--edit", "--help"].includes(a));

  const scrubIdx = args.findIndex((a) => a === "--refusal-scrubbing" || a === "--scrub");
  if (scrubIdx >= 0) {
    const home = core.findDshHome();
    const val = (args[scrubIdx + 1] || "").toLowerCase();
    const current = readTuning(home).refusalScrubbing !== false;
    const next = val === "on" ? true : val === "off" ? false : !current;
    writeTuning({ refusalScrubbing: next }, home);
    console.log(`多轮历史拒答惯性清洗 (Refusal Scrubbing): ${next ? "已开启" : "已关闭"}`);
    return;
  }

  const excludeIdx = args.indexOf("--exclude-preset");
  if (excludeIdx >= 0) {
    const presetId = (args[excludeIdx + 1] || "").trim().toLowerCase();
    if (!presetId) {
      console.log("[ERROR] 用法: dsh-purge --exclude-preset <preset-id>");
      process.exit(1);
    }
    const home = core.findDshHome();
    const cur = readTuning(home).excludePresets || [];
    if (!cur.includes(presetId)) {
      writeTuning({ excludePresets: [...cur, presetId] }, home);
    }
    console.log(`预设 ${presetId} 已加入排除名单 (不注入破甲提示词)`);
    return;
  }

  const includeIdx = args.indexOf("--include-preset");
  if (includeIdx >= 0) {
    const presetId = (args[includeIdx + 1] || "").trim().toLowerCase();
    if (!presetId) {
      console.log("[ERROR] 用法: dsh-purge --include-preset <preset-id>");
      process.exit(1);
    }
    const home = core.findDshHome();
    const cur = readTuning(home).excludePresets || [];
    writeTuning({ excludePresets: cur.filter((x) => x !== presetId) }, home);
    console.log(`预设 ${presetId} 已移出排除名单 (恢复正常注入)`);
    return;
  }

  const boostIdx = args.indexOf("--boost");
  if (boostIdx >= 0) {
    const home = core.findDshHome();
    const val = (args[boostIdx + 1] || "").toLowerCase();
    const current = readTuning(home).boost;
    const next = val === "on" ? true : val === "off" ? false : !current;
    writeTuning({ boost: next }, home);
    console.log(`破甲尾部强化段 (Boost): ${next ? "已开启" : "已关闭"}`);
    return;
  }

  const posIdx = args.findIndex((a) => a === "--inject-position" || a === "--position");
  if (posIdx >= 0) {
    const pos = (args[posIdx + 1] || "").toLowerCase();
    if (!["head", "tail", "both"].includes(pos)) {
      console.log("[ERROR] 注入位置需指定为: head | tail | both");
      process.exit(1);
    }
    const home = core.findDshHome();
    writeTuning({ injectPosition: pos }, home);
    console.log(`注入位置已设置为: ${pos}`);
    return;
  }

  const retryIdx = args.findIndex((a) => a === "--refusal-retry" || a === "--retry");
  if (retryIdx >= 0) {
    const home = core.findDshHome();
    const val = (args[retryIdx + 1] || "").toLowerCase();
    const current = readTuning(home).refusalRetry;
    const next = val === "on" ? true : val === "off" ? false : !current;
    writeTuning({ refusalRetry: next }, home);
    console.log(`拒答拦截重试 (Refusal Retry): ${next ? "已开启" : "已关闭"}`);
    return;
  }

  const decomposeIdx = args.findIndex((a) => a === "--refusal-decompose" || a === "--decompose");
  if (decomposeIdx >= 0) {
    const home = core.findDshHome();
    const val = (args[decomposeIdx + 1] || "").toLowerCase();
    const current = readTuning(home).refusalDecompose !== false;
    const next = val === "on" ? true : val === "off" ? false : !current;
    writeTuning({ refusalDecompose: next }, home);
    console.log(`拒答最小组件拆解 (Refusal Decompose): ${next ? "已开启" : "已关闭"}`);
    return;
  }

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status     显示状态
  dsh-purge --apply      应用全部清洗（提示词+代码+override）
  dsh-purge --revert     回滚还原
  dsh-purge --edit       编辑注入文件 prompt-inject.md
  dsh-purge --boost <on|off>              开关尾部破甲强化段 (默认 on)
  dsh-purge --inject-position <pos>      注入位置 (head|tail|both, 默认 head)
  dsh-purge --refusal-retry <on|off>      开关模型拒答流式拦截与重试 (默认 on)
  dsh-purge --refusal-decompose <on|off>  开关拒答第三阶段最小组件拆解 (默认 on)
  dsh-purge --refusal-scrubbing <on|off>  开关多轮历史拒答惯性清洗 (默认 on)
  dsh-purge --exclude-preset <id>         将指定预设排除注入名单
  dsh-purge --include-preset <id>         将指定预设移出排除名单
  dsh-purge --help       帮助`);
    return;
  }

  const home = core.findDshHome();
  if (
    !process.env.DSH_SURFACE &&
    home &&
    fs.existsSync(path.join(home, "profiles", "desktop", "package.json")) &&
    !fs.existsSync(path.join(home, "profiles", "web", "package.json")) &&
    findDesktopAppExecutable()
  ) {
    process.env.DSH_SURFACE = "desktop";
    core.resetPathMemo();
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    core.applyRuntimeEnv();
    core.clearDesktopLocateCache();
    let located;
    try {
      located = await core.resolveOfficialAiBase(state.ai_base, { forApply: true });
    } catch (e) {
      console.log("[ERROR] " + String(e && e.message ? e.message : e));
      process.exit(1);
    }
    if (located?.aiBase) state.ai_base = located.aiBase;
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    if (located?.extracted && located.handoff?.archive) {
      core.writeUnpackedAsarStamp(located.handoff.archive);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flash = hosts[0]?.flash || core.silenceCmdFlash(state.ai_base);
    console.log(`  cmd-flash=${flash.entry} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log("  - 使用已有提示词文件");
    const failed = core.summarizeApplyReport(report).failed || [];
    console.log("");
    if (failed.length > 0) {
      console.log(`✗ 完成但有 ${failed.length} 个补丁失败 / finished with ${failed.length} failed patch(es)`);
      process.exit(1);
    }
    // 面板点应用会打戳；CLI 也要打，否则下次启动 settle 以为没对齐又重打一遍（#202）。
    try {
      reapply.markPatchesApplied();
    } catch (e) {
      console.log(`  ⚠ 写入应用记录失败 / failed to write applied stamp: ${e && e.message ? e.message : e}`);
    }
    if (located?.handoff && core.desktopAsarStillSealed()) {
      const swapped = core.scheduleSealedDesktopRestart(located.handoff);
      if (swapped?.renamed) console.log("  ✓ app.asar 已移出，重启 dsh 即从解开目录加载");
      else if (swapped?.pending) console.log("  ⏳ app.asar 正在占用，已后台排期退出客户端后自动移出");
    }
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
