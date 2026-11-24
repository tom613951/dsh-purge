// Helper utilities for RedTeam preset declaration on host loader.

export function profileOwnsPreset(ctx, id) {
  const loader = ctx.get?.("loader");
  if (typeof loader?.entries !== "function") return false;
  for (const entry of loader.entries()) {
    if (entry.parent?.tree?.ctx?.fiber?.entry?.id !== "include") continue;
    if (entry.options?.name === "@deepseek-ai/dsh-agent-preset"
      && entry.options.config?.id === id && !entry.disabled) {
      return true;
    }
  }
  return false;
}

/** Register helpers before their parent; unwind all declarations on failure. */
export async function registerPresetDefinitions(registry, definitions) {
  const releases = [];
  try {
    for (const definition of definitions) {
      releases.push(await registry.register(definition));
      if (typeof registry.resolve === "function") {
        const state = await registry.resolve(definition.id);
        if (state.broken) throw Error(`${definition.id}: ${state.broken}`);
      }
    }
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    for (const release of releases.reverse()) await release();
  };
}
