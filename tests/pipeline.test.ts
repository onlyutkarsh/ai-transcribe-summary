import { describe, expect, it, vi } from "vitest";

// pipeline.ts pulls in settings.ts and providers/factory.ts, which pull in Obsidian UI classes
// (PluginSettingTab, createFragment, ...) not worth stubbing just to satisfy a module-level
// import - the functions under test here need none of it.
vi.mock("obsidian", () => ({
	normalizePath: (path: string) => path,
	MarkdownView: class {},
}));
vi.mock("../src/settings", () => ({}));
vi.mock("../src/providers/factory", () => ({}));
vi.mock("../src/providers/map-reduce-summarizer", () => ({}));

const { resolveNonCollidingPath, resolveNonCollidingPathWithExtension, resolveSummaryTarget, writeIntoTargetNote } = await import("../src/pipeline");

/** Minimal fake App - only the vault.getAbstractFileByPath lookup that resolveNonCollidingPath(WithExtension) reads. `existingPaths` mimics files already present in the vault. */
function fakeApp(existingPaths: string[]) {
	return {
		vault: {
			getAbstractFileByPath: (path: string) => (existingPaths.includes(path) ? {} : null),
		},
	} as unknown as import("obsidian").App;
}

describe("resolveNonCollidingPath", () => {
	it("returns the plain <folder>/<name>.md path when nothing is there yet", () => {
		const app = fakeApp([]);
		expect(resolveNonCollidingPath(app, "meetings", "Team Sync")).toBe("meetings/Team Sync.md");
	});

	it("appends a timestamp when the path is already taken", () => {
		const app = fakeApp(["meetings/Team Sync.md"]);
		const resolved = resolveNonCollidingPath(app, "meetings", "Team Sync");
		expect(resolved).not.toBe("meetings/Team Sync.md");
		expect(resolved.startsWith("meetings/Team Sync ")).toBe(true);
		expect(resolved.endsWith(".md")).toBe(true);
	});
});

describe("resolveNonCollidingPathWithExtension", () => {
	it("returns the plain <folder>/<name>.<ext> path when nothing is there yet", () => {
		const app = fakeApp([]);
		expect(resolveNonCollidingPathWithExtension(app, "audio", "meeting 2026-09-03", "webm")).toBe("audio/meeting 2026-09-03.webm");
	});

	it("appends a timestamp when the path is already taken - guards a template with no time component", () => {
		const app = fakeApp(["audio/meeting 2026-09-03.webm"]);
		const resolved = resolveNonCollidingPathWithExtension(app, "audio", "meeting 2026-09-03", "webm");
		expect(resolved).not.toBe("audio/meeting 2026-09-03.webm");
		expect(resolved.startsWith("audio/meeting 2026-09-03 ")).toBe(true);
		expect(resolved.endsWith(".webm")).toBe(true);
	});
});

describe("file naming end-to-end (audio/transcript/summary sharing one folder)", () => {
	// Transcript/summary notes are always named from the audio file's own basename plus a fixed
	// "-transcript"/"-summary" suffix - no template involved, so the two can never collide with each
	// other (or with the audio file itself) even when all three folders point at the same place.
	const audioBaseName = "2026-09-03 14-05-09";

	it("produces three distinct file names from one shared folder and one shared audio base name", () => {
		const app = fakeApp([]);
		const audioPath = resolveNonCollidingPathWithExtension(app, "meetings", audioBaseName, "webm");
		const transcriptPath = resolveNonCollidingPath(fakeApp([audioPath]), "meetings", `${audioBaseName}-transcript`);
		const summaryPath = resolveNonCollidingPath(fakeApp([audioPath, transcriptPath]), "meetings", `${audioBaseName}-summary`);

		expect(new Set([audioPath, transcriptPath, summaryPath]).size).toBe(3);
		expect(audioPath).toBe("meetings/2026-09-03 14-05-09.webm");
		expect(transcriptPath).toBe("meetings/2026-09-03 14-05-09-transcript.md");
		expect(summaryPath).toBe("meetings/2026-09-03 14-05-09-summary.md");
	});

	it("uses the existing audio file's own name directly when re-running on an already-named file", () => {
		const app = fakeApp([]);
		const transcriptPath = resolveNonCollidingPath(app, "meetings", "podcast-clip-transcript");
		const summaryPath = resolveNonCollidingPath(fakeApp([transcriptPath]), "meetings", "podcast-clip-summary");

		expect(transcriptPath).toBe("meetings/podcast-clip-transcript.md");
		expect(summaryPath).toBe("meetings/podcast-clip-summary.md");
	});
});

describe("writeIntoTargetNote", () => {
	/** Fake App with one target note whose contents live in `state.data`, and whatever view is "focused" - `activeFile` is the note that view shows (null for none). */
	function fakeTargetApp(initialData: string, activeFile: object | null) {
		const state = { data: initialData, inserted: undefined as { text: string; at: unknown } | undefined };
		const app = {
			workspace: {
				getActiveViewOfType: () =>
					activeFile
						? {
								file: activeFile,
								editor: {
									getCursor: (which?: string) => (which === "to" ? "selection-end" : "selection-start"),
									replaceRange: (text: string, at: unknown) => (state.inserted = { text, at }),
								},
							}
						: null,
			},
			vault: {
				process: async (_file: unknown, fn: (data: string) => string) => (state.data = fn(state.data)),
			},
		} as unknown as import("obsidian").App;
		return { app, state };
	}

	const target = { path: "meetings/Standup.md" } as unknown as import("obsidian").TFile;

	it("inserts after the selection, without replacing it, when the target note is the focused one", async () => {
		const { app, state } = fakeTargetApp("# Standup\n", target);
		await writeIntoTargetNote(app, target, "Summary\n", undefined);
		expect(state.inserted).toEqual({ text: "Summary\n", at: "selection-end" });
		expect(state.data).toBe("# Standup\n");
	});

	it("appends to the target note when the user has navigated to a different note", async () => {
		const { app, state } = fakeTargetApp("# Standup\nagenda\n\n", { path: "other.md" });
		await writeIntoTargetNote(app, target, "Summary\n", "## Full Transcript\n\ntext\n");
		expect(state.inserted).toBeUndefined();
		expect(state.data).toBe("# Standup\nagenda\n\nSummary\n\n## Full Transcript\n\ntext\n");
	});

	it("appends without leading blank lines when the target note is empty and nothing is focused", async () => {
		const { app, state } = fakeTargetApp("", null);
		await writeIntoTargetNote(app, target, "Summary\n", undefined);
		expect(state.data).toBe("Summary\n");
	});
});

describe("resolveSummaryTarget", () => {
	type TargetSettings = Parameters<typeof resolveSummaryTarget>[0];
	const note = (path: string) => ({ path }) as unknown as import("obsidian").TFile;
	const startNote = note("meetings/Standup.md");
	const otherNote = note("research.md");
	const settings = (overrides: Partial<TargetSettings>): TargetSettings => ({
		generateSummary: true,
		summaryPlacement: "active-note",
		summaryTargetNote: "recording-start",
		...overrides,
	});

	it("keeps the note open at start even after the user navigated elsewhere", () => {
		expect(resolveSummaryTarget(settings({}), { startedIn: startNote, openNow: otherNote })).toEqual({ kind: "note", file: startNote });
	});

	it("falls back to the note open now when nothing was open at start", () => {
		expect(resolveSummaryTarget(settings({}), { startedIn: undefined, openNow: otherNote })).toEqual({ kind: "note", file: otherNote });
	});

	it("uses the note open now under recording-stop, ignoring the start note", () => {
		expect(resolveSummaryTarget(settings({ summaryTargetNote: "recording-stop" }), { startedIn: startNote, openNow: otherNote })).toEqual({
			kind: "note",
			file: otherNote,
		});
	});

	it("resolves to a new note when no note was ever open", () => {
		expect(resolveSummaryTarget(settings({}), { startedIn: undefined, openNow: undefined })).toEqual({ kind: "note", file: undefined });
	});

	it("asks, suggesting the start note then the note open now", () => {
		expect(resolveSummaryTarget(settings({ summaryTargetNote: "ask" }), { startedIn: startNote, openNow: otherNote })).toEqual({
			kind: "ask",
			suggested: [
				{ file: startNote, reason: "open when recording started" },
				{ file: otherNote, reason: "open now" },
			],
		});
	});

	it("suggests a note only once when the user never left it", () => {
		const target = resolveSummaryTarget(settings({ summaryTargetNote: "ask" }), { startedIn: startNote, openNow: startNote });
		expect(target).toEqual({ kind: "ask", suggested: [{ file: startNote, reason: "open when recording started" }] });
	});

	it("asks with nothing suggested when no note is open", () => {
		expect(resolveSummaryTarget(settings({ summaryTargetNote: "ask" }), { startedIn: undefined, openNow: undefined })).toEqual({ kind: "ask", suggested: [] });
	});

	it("doesn't ask when the summary would go to a dedicated file anyway", () => {
		const target = resolveSummaryTarget(settings({ summaryTargetNote: "ask", summaryPlacement: "dedicated-file" }), { startedIn: startNote, openNow: otherNote });
		expect(target.kind).toBe("note");
	});

	it("doesn't ask when summary generation is off", () => {
		const target = resolveSummaryTarget(settings({ summaryTargetNote: "ask", generateSummary: false }), { startedIn: startNote, openNow: otherNote });
		expect(target.kind).toBe("note");
	});
});
