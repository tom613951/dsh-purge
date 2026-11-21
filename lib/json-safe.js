/**
 * Lossless / fail-safe JSON normalization helpers (pure ESM, zero external deps).
 *
 * Ensures tool outputs and persisted hashes handle -0, NaN, Infinity, BigInt,
 * Error, Map, Set, Date, and circular references without throwing or silently
 * dropping critical error context.
 */

function isOmitted(value) {
  const t = typeof value;
  return t === "undefined" || t === "function" || t === "symbol";
}

/**
 * Normalize an arbitrary JS value into a pure JSON-safe structure.
 *
 * @param {unknown} value
 * @param {number} [maxDepth=128]
 * @returns {unknown}
 */
export function sanitizeJsonValue(value, maxDepth = 128) {
  const ancestors = new WeakSet();

  function visit(item, depth) {
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return null;
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === "bigint") return String(item);
    if (isOmitted(item)) return null;
    if (depth >= maxDepth) return "[MaxDepth]";

    if (item instanceof Date) {
      return Number.isFinite(item.getTime()) ? item.toISOString() : null;
    }
    if (item instanceof RegExp) {
      return String(item);
    }

    if (ancestors.has(item)) return "[Circular]";
    ancestors.add(item);

    try {
      if (item instanceof Error) {
        const out = {
          name: typeof item.name === "string" && item.name ? item.name : "Error",
          message: typeof item.message === "string" ? item.message : String(item.message ?? ""),
        };
        if (item.code !== undefined) out.code = visit(item.code, depth + 1);
        return out;
      }

      if (item instanceof Set) {
        const out = [];
        for (const elem of item) {
          out.push(isOmitted(elem) ? null : visit(elem, depth + 1));
        }
        return out;
      }

      if (item instanceof Map) {
        const out = {};
        for (const [k, v] of item.entries()) {
          if (isOmitted(v)) continue;
          const key = typeof k === "string" ? k : String(k);
          Object.defineProperty(out, key, {
            value: visit(v, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      }

      if (Array.isArray(item)) {
        const out = new Array(item.length);
        for (let i = 0; i < item.length; i += 1) {
          const elem = item[i];
          out[i] = isOmitted(elem) ? null : visit(elem, depth + 1);
        }
        return out;
      }

      if (Buffer.isBuffer(item)) {
        return Array.from(item);
      }

      const out = {};
      for (const key of Object.keys(item)) {
        let v;
        try {
          v = item[key];
        } catch (err) {
          v = `[Thrown: ${err && err.message ? err.message : String(err)}]`;
        }
        if (isOmitted(v)) continue;
        Object.defineProperty(out, key, {
          value: visit(v, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    } finally {
      ancestors.delete(item);
    }
  }

  return visit(value, 0);
}

/**
 * Safely stringify any value as formatted JSON.
 *
 * @param {unknown} value
 * @param {number} [space=2]
 * @returns {string}
 */
export function safeJsonStringify(value, space = 2) {
  return JSON.stringify(sanitizeJsonValue(value), null, space);
}

/**
 * Deterministic canonical JSON (sorted object keys) over a sanitized value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const safe = sanitizeJsonValue(value);

  function encode(node) {
    if (node === null || typeof node !== "object") return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map(encode).join(",")}]`;
    const keys = Object.keys(node).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(node[k])}`).join(",")}}`;
  }

  return encode(safe);
}
