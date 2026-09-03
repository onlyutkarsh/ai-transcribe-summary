import { describe, expect, it, vi } from "vitest";

// pipeline.ts pulls in settings.ts and providers/factory.ts, which pull in Obsidian UI classes
// (PluginSettingTab, createFragment, ...) not worth stubbing just to satisfy a module-level
// import - the functions under test here need none of it.
vi.mock("obsidian", () => ({
	normalizePath: (path: string) => path,
}));
vi.mock("../src/settings", () => ({}));
vi.mock("../src/providers/factory", () => ({}));
vi.mock("../src/providers/map-reduce-summarizer", () => ({}));

const { resolveNonCollidingPath, resolveNonCollidingPathWithExtension } = await import("../src/pipeline");

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
