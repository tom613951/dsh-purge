import { detectSurface } from "./surface.js";
import * as desktop from "./desktop.js";

export function currentSurface(input) {
  return detectSurface(input);
}

export function hostAdapter() {
  return desktop;
}

export function scheduleRestart(request, ctx, options = {}) {
  return hostAdapter().scheduleRestart(request, ctx, options);
}

export function restartNote() {
  return hostAdapter().restartNote();
}
