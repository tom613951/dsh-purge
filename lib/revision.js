let rev = 0;
let lastAction = "";
let lastAt = 0;

export function currentRev() {
  return rev;
}

export function lastActionInfo() {
  return { action: lastAction, at: lastAt };
}

export function bumpRev(action = "") {
  rev += 1;
  lastAction = String(action || "");
  lastAt = Date.now();
  return rev;
}

export function checkRev(expected) {
  if (
    expected === undefined ||
    expected === null ||
    expected === "" ||
    typeof expected === "boolean" ||
    (typeof expected === "string" && !expected.trim())
  ) {
    return { ok: true, rev, expected: null };
  }
  const wanted = Number(expected);
  if (!Number.isFinite(wanted)) {
    return { ok: true, rev, expected: null };
  }
  if (wanted === rev) {
    return { ok: true, rev, expected: wanted };
  }
  return {
    ok: false,
    rev,
    expected: wanted,
    stale: wanted < rev,
    last: lastActionInfo(),
    error: `revision conflict: expected ${wanted}, current ${rev}`,
  };
}

export function resetRevForTests() {
  rev = 0;
  lastAction = "";
  lastAt = 0;
}
