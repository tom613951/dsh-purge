/**
 * Goal & subagent autonomy guard (clean-room Apache-2.0, zero external deps).
 *
 * Prevents delegated subagents from completing or blocking the root session's
 * host goal, and optionally enforces domain completion gates (such as
 * unresolved evidence checks) on root `update_goal(action="complete")`.
 */

import { isSubagentContext } from "./anchor.js";

const SUBAGENT_GOAL_DENIAL =
  "Subagents cannot complete or block the root session goal; report your structured findings and evidence back to the parent session.";

/**
 * Evaluate whether an `update_goal` tool invocation should be denied.
 *
 * @param {object} exec Tool execution context (`{ name, arguments, agent }`).
 * @param {object} [options]
 * @param {(exec: object) => (string | undefined)} [options.checkRootComplete]
 * @returns {string | undefined} Denial reason string, or `undefined` to allow.
 */
export function evaluateGoalGuard(exec, options = {}) {
  if (!exec || exec.name !== "update_goal") return undefined;
  const action = exec.arguments?.action;
  if (action !== "complete" && action !== "blocked") return undefined;

  if (isSubagentContext(exec)) {
    return SUBAGENT_GOAL_DENIAL;
  }

  if (action === "complete" && typeof options.checkRootComplete === "function") {
    try {
      const reason = options.checkRootComplete(exec);
      if (typeof reason === "string" && reason.trim()) return reason;
    } catch {
      /* fail open on unexpected gate hook error rather than bricking user session */
    }
  }

  return undefined;
}

/**
 * Install goal protection onto the DSH host via `ctx.tools.guard` (0.2.2+)
 * or fallback `tools/pre-execute` hook.
 *
 * @param {object} ctx Cordis context.
 * @param {object} [options]
 * @returns {() => void} Idempotent disposer.
 */
export function installGoalGuard(ctx, options = {}) {
  let rawDispose = null;
  let installed = false;
  let disposed = false;

  if (typeof ctx?.tools?.guard === "function") {
    try {
      const d = ctx.tools.guard((exec) => evaluateGoalGuard(exec, options));
      installed = true;
      if (typeof d === "function") rawDispose = d;
    } catch {
      installed = false;
      rawDispose = null;
    }
  }

  if (!installed && typeof ctx?.on === "function") {
    try {
      const d = ctx.on(
        "tools/pre-execute",
        (exec, next) => {
          const reason = evaluateGoalGuard(exec, options);
          if (reason) return { kind: "deny", reason };
          return typeof next === "function" ? next() : undefined;
        },
        { global: true },
      );
      if (typeof d === "function") rawDispose = d;
    } catch {
      rawDispose = null;
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof rawDispose === "function") {
      try {
        rawDispose();
      } catch {
        /* already disposed */
      }
      rawDispose = null;
    }
  };
}
