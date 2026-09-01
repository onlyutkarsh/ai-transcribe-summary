## Project

Obsidian plugin (desktop only, `manifest.json` sets `isDesktopOnly: true`). Records meetings, transcribes via Whisper (OpenAI/OpenRouter), and optionally summarizes/cleans up the transcript via an LLM (OpenAI/OpenRouter Chat Completions).

## Build, test, typecheck

- `npm test` - runs the vitest suite (`vitest run`).
- `npm run build` - `tsc -noEmit -skipLibCheck` then the esbuild production bundle. Run the typecheck step (`npx tsc -noEmit -skipLibCheck`) and `npm test` after any change - both are fast and must stay clean.
- Tests live under `tests/`, mirroring `src/`. The `obsidian` package ships types only (no runtime JS - Obsidian provides the module at plugin-load time), so any file that imports a runtime symbol from `obsidian` (`Notice`, `requestUrl`, etc.) needs the `obsidian` -> `tests/__mocks__/obsidian.ts` alias in `vitest.config.ts` to be importable in a test at all. Extend that stub, don't route around it.

## Code conventions (follow what's already here)

- No comments explaining *what* code does - only *why*, for non-obvious constraints, workarounds, or invariants. Most functions/files carry a single doc comment stating the non-obvious rationale for their existence or design, not a description of their mechanics.
- Don't add error handling/fallbacks for scenarios that can't happen. Validate at real boundaries (user input, external API responses) only.
- Keep provider/orchestration logic UI-framework-free where possible - `src/log.ts` exists specifically so `logDebug` doesn't pull the Obsidian `PluginSettingTab` UI class into files that don't need it (see `src/pipeline.ts`, `src/providers/*.ts`). Don't reintroduce that coupling.
- User-facing strings (setting labels/descriptions, `Notice` text, modal copy, command names) must read as plain product copy - no internal references ("PRD", "Tier N", implementation details, competitor comparisons). Code *comments* referencing internal design rationale are fine; anything rendered to the user is not the place for it.
- Match existing patterns before introducing new ones: async generators for memory-bounded streaming (`src/audio/chunker.ts`), bounded worker pools for concurrency (`src/providers/whisper-transcription-provider.ts`), map-reduce splitting for oversized LLM inputs (`src/providers/transcript-splitter.ts`, `src/providers/map-reduce-summarizer.ts`).
- `src/settings.ts`'s `SettingDefinitionItem`s must have a unique `name` and, for controls, a unique `control.key` *within their containing group's `items` array* - Obsidian's renderer dedupes by `name:<name>` and `ctrl:<control.key>` regardless of `visible`, so two per-provider items with the same literal name/key (e.g. building "Model"/"API key" fields identically for openai/openrouter/gemini in a loop) collide even though only one is ever shown at a time. It warns to the console (`duplicate setting key "..."`) rather than throwing. Always interpolate the provider id or label into both `name` and `control.key` for anything built per-provider (see `buildTranscriptionProviderFields`/`buildSummaryProviderFields`); when a control key must map to one shared underlying setting (not a separate value per provider, e.g. `reuseWhisperKeyForSummary`), qualify the key per-provider anyway (`` `reuseWhisperKeyForSummary.${providerId}` ``) and fan all the qualified keys into the same field in `getControlValue`/`setControlValue` (and into `VISIBILITY_DRIVING_KEYS` if the setting gates another item's `visible`).
- Always call `window.requestAnimationFrame()`/`window.cancelAnimationFrame()`, never the bare global - Obsidian popout windows run in a separate `window` context, and the unqualified global resolves to the main window's, breaking animation loops (e.g. the level meter in `src/audio/recorder.ts`) opened in a popout.

## Git

- Commit subjects use Conventional Commits prefixes (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`, etc.).
- Only commit when explicitly asked.
