import { describe, expect, it, vi } from "vitest";
import { CLEANUP_CHUNK_CHARS, cleanUpTranscript } from "../../src/providers/chunked-cleanup";
import { RequestAbortedError } from "../../src/providers/request-timeout";
import { SummaryProvider, SummaryRequest, SummaryResult } from "../../src/providers/summary";

function fakeProvider(summarize: (request: SummaryRequest) => Promise<SummaryResult>): SummaryProvider {
	return { id: "openai", summarize };
}

/** Whisper output is one run-on block with no paragraph breaks, so chunking has to fall back to sentence boundaries. */
function sentences(count: number): string {
	return Array.from({ length: count }, (_, i) => `Sentence number ${i} of the meeting.`).join(" ");
}

describe("cleanUpTranscript", () => {
	it("sends a short transcript in one request", async () => {
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => ({ summary: `clean: ${request.transcript}` }));

		const result = await cleanUpTranscript(fakeProvider(summarize), { transcript: "um hello", prompt: "CLEANUP", step: "cleanup" });

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(summarize).toHaveBeenCalledWith({ transcript: "um hello", prompt: "CLEANUP", step: "cleanup" });
		expect(result).toBe("clean: um hello");
	});

	it("splits a long transcript so no request exceeds the chunk size, preserving order", async () => {
		const transcript = sentences(3000);
		const seen: string[] = [];
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => {
			seen.push(request.transcript);
			return { summary: request.transcript };
		});
		const progress: string[] = [];

		const result = await cleanUpTranscript(fakeProvider(summarize), { transcript, prompt: "CLEANUP", step: "cleanup" }, (status) => progress.push(status));

		expect(seen.length).toBeGreaterThan(1);
		expect(seen.every((chunk) => chunk.length <= CLEANUP_CHUNK_CHARS)).toBe(true);
		expect(summarize.mock.calls.every(([request]) => request.prompt === "CLEANUP")).toBe(true);
		expect(result.replace(/\s+/g, " ")).toBe(transcript);
		expect(progress).toContain(`Cleaning up part 1 of ${seen.length}`);
	});

	it("keeps a chunk's original text when its cleanup comes back empty", async () => {
		const summarize = vi.fn(async (): Promise<SummaryResult> => ({ summary: "   " }));

		expect(await cleanUpTranscript(fakeProvider(summarize), { transcript: "original text", prompt: "CLEANUP" })).toBe("original text");
	});

	it("stops before the next chunk once aborted", async () => {
		const controller = new AbortController();
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => {
			controller.abort();
			return { summary: request.transcript };
		});

		await expect(cleanUpTranscript(fakeProvider(summarize), { transcript: sentences(3000), prompt: "CLEANUP", signal: controller.signal })).rejects.toBeInstanceOf(RequestAbortedError);
		expect(summarize).toHaveBeenCalledTimes(1);
	});
});
