/**
 * Tests run under plain Node, which has no `window` global. Obsidian's plugin runtime is an
 * Electron renderer, where `window === globalThis` - source code relies on `window.setTimeout`/
 * `window.setInterval` (Obsidian's own lint rules require this over the bare global, for
 * popout-window compatibility), so tests need the same global available under the same name.
 */
if (typeof window === "undefined") {
	(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}
