import { adapterFor, detectSurface } from "../surface.js";
import { PATCHES } from "./prompt.js";
import { CODE_PATCHES } from "./code.js";
import { ENGINE_PATCHES } from "./engine.js";
import { NEW_TOOL_PATCHES } from "./tools.js";
import { STABILITY_PATCHES } from "./stability.js";

export {
  PATCHES,
  CODE_PATCHES,
  ENGINE_PATCHES,
  NEW_TOOL_PATCHES,
  STABILITY_PATCHES,
};

export const ALL_PATCHES = [
  ...PATCHES,
  ...CODE_PATCHES,
  ...ENGINE_PATCHES,
  ...NEW_TOOL_PATCHES,
  ...STABILITY_PATCHES,
];

/** 同一条清洗的升级链。Apply 仍按 ALL_PATCHES 全打，只有清洗页 / 计数展示合成一行。 */
export const PATCH_DISPLAY_GROUPS = {
  disclaimer: [1, 2, 3],
  approval_sentence: [5, 11, 12],
  approval_policy: [8, 9, 10],
  desktop_update: [45, 46],
  desktop_close: [83, 84],
  followup: [85, 86, 99],
  hang: [87, 88],
  hooks_deny: [30, 31],
  hooks_steer: [64, 65],
  inspector_budget: [96, 97],
};

const DISPLAY_GROUP_BY_ID = new Map();
for (const [key, ids] of Object.entries(PATCH_DISPLAY_GROUPS)) {
  for (const id of ids) DISPLAY_GROUP_BY_ID.set(id, key);
}

const DISPLAY_SKIP = new Set(["skipped", "missing_file", "off"]);
const DISPLAY_DONE = new Set(["applied", "already"]);

export function patchAppliesHere(patch, surface = detectSurface()) {
  const want = patch?.surfaces;
  if (!Array.isArray(want) || want.length === 0) return true;
  const adapter = adapterFor(surface);
  return want.includes(adapter) || want.includes(surface);
}

export function rollupDisplayStatus(statuses) {
  const list = (statuses || []).filter(Boolean);
  if (list.length === 0) return "skipped";
  if (list.some((s) => s === "pending")) return "pending";
  if (list.some((s) => s === "unmatched")) return "unmatched";
  // 漂移压过"已完成"：一组里只要有一条对不上官方原文，这组就不是干净的。
  if (list.some((s) => s === "drifted")) return "drifted";
  if (list.every((s) => DISPLAY_SKIP.has(s))) return "skipped";
  if (list.some((s) => DISPLAY_DONE.has(s))) return "applied";
  return "skipped";
}

export function groupPatchesForDisplay(patches = ALL_PATCHES, patch_status = {}, surface) {
  const buckets = new Map();
  for (const p of patches) {
    if (!patchAppliesHere(p, surface)) continue;
    const st = patch_status[p.id];
    if (!st || st === "na") continue;
    const key = DISPLAY_GROUP_BY_ID.get(p.id) || `solo:${p.id}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { lead: p, ids: [], statuses: [] };
      buckets.set(key, bucket);
    }
    bucket.ids.push(p.id);
    bucket.statuses.push(st);
    if (p.id < bucket.lead.id) bucket.lead = p;
  }
  return [...buckets.values()]
    .sort((a, b) => a.lead.id - b.lead.id)
    .map((bucket) => ({
      id: bucket.lead.id,
      ids: bucket.ids,
      layer: bucket.lead.layer || "",
      status: rollupDisplayStatus(bucket.statuses),
    }));
}

export function tallyDisplayPatches(rows) {
  const out = { applied: 0, pending: 0, unmatched: 0, skipped: 0, drifted: 0, total: 0, ready: 0 };
  for (const row of rows || []) {
    const st = row.status || row.st;
    out.total += 1;
    if (st === "applied" || st === "already") {
      out.applied += 1;
      out.ready += 1;
    } else if (st === "pending") out.pending += 1;
    else if (st === "unmatched") out.unmatched += 1;
    else if (st === "drifted") {
      // 漂移不算就绪：这正是"看起来全绿、实际没打上"的来源。
      out.drifted += 1;
    } else {
      out.skipped += 1;
      out.ready += 1;
    }
  }
  return out;
}
