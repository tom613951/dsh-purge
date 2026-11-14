// 跨纪元版本比较与预发布渠道标记（零依赖，供更新器与 RedTeam UI 共用）。

export function isBetaName(name) {
  return /(?:^|[-._])(beta|alpha|pre|preview|test)(?:\d|$|[-._])/i.test(String(name || ""));
}

export function splitVersion(raw) {
  const text = String(raw || "").trim().replace(/^v/i, "");
  const cut = text.split("-");
  const core = String(cut[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
  return { core: [core[0] || 0, core[1] || 0, core[2] || 0], pre: cut.slice(1).join("-") };
}

export function versionEpoch(core) {
  return core[0] === 1 && (core[1] === 1 || core[1] === 2) ? 0 : 1;
}

export function compareVersionPre(aPre, bPre) {
  if (!aPre && !bPre) return 0;
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  const ta = String(aPre).split(/[.-]/).filter(Boolean);
  const tb = String(bPre).split(/[.-]/).filter(Boolean);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= ta.length) return -1;
    if (i >= tb.length) return 1;
    const xa = ta[i];
    const xb = tb[i];
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      const ia = Number(xa);
      const ib = Number(xb);
      if (ia !== ib) return ia > ib ? 1 : -1;
      continue;
    }
    if (xa !== xb) return xa > xb ? 1 : -1;
  }
  return 0;
}

export function versionIsNewer(remote, local) {
  if (!remote) return false;
  if (!local) return true;
  if (String(remote) === String(local)) return false;
  const a = splitVersion(remote);
  const b = splitVersion(local);
  const epochA = versionEpoch(a.core);
  const epochB = versionEpoch(b.core);
  if (epochA !== epochB) return epochA > epochB;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return compareVersionPre(a.pre, b.pre) > 0;
}
