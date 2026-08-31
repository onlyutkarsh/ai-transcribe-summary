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

## Git

- Commit subjects use Conventional Commits prefixes (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`, etc.).
- Only commit when explicitly asked.
