import { describe, expect, it, vi } from "vitest";
import { summarizeLongTranscript } from "../../src/providers/map-reduce-summarizer";
import { SUMMARY_CHUNK_THRESHOLD_CHARS } from "../../src/providers/transcript-splitter";
import { SummaryProvider, SummaryRequest, SummaryRequestTooLargeError, SummaryResult } from "../../src/providers/summary";

function fakeProvider(summarize: (request: SummaryRequest) => Promise<SummaryResult>): SummaryProvider {
	return { id: "openai", summarize };
}

describe("summarizeLongTranscript", () => {
	it("calls the provider once, unchanged, for a short transcript", async () => {
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => ({ summary: `summary of: ${request.transcript}` }));
		const provider = fakeProvider(summarize);

		const result = await summarizeLongTranscript(provider, { transcript: "short transcript", prompt: "user prompt" });

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(summarize).toHaveBeenCalledWith({ transcript: "short transcript", prompt: "user prompt" });
		expect(result.summary).toBe("summary of: short transcript");
	});

	it("sends a long transcript in one request when the provider accepts it", async () => {
		const longTranscript = "long transcript ".repeat(SUMMARY_CHUNK_THRESHOLD_CHARS / 10);
		const summarize = vi.fn(async (): Promise<SummaryResult> => ({ summary: "summary" }));
		const provider = fakeProvider(summarize);

		await summarizeLongTranscript(provider, { transcript: longTranscript, prompt: "USER_PROMPT" });

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(summarize).toHaveBeenCalledWith({ transcript: longTranscript, prompt: "USER_PROMPT" });
	});

	it("map-reduces only after the provider rejects an oversized request", async () => {
		const paragraphChars = Math.ceil(SUMMARY_CHUNK_THRESHOLD_CHARS / 5);
		const longTranscript = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`.repeat(paragraphChars / "Paragraph 0.".length)).join("\n\n");
		const calls: SummaryRequest[] = [];
		let initialAttempt = true;
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => {
			if (initialAttempt || request.transcript.length > 100_000) {
				initialAttempt = false;
				throw new SummaryRequestTooLargeError("context length exceeded");
			}
			calls.push(request);
			return { summary: `digest-${calls.length}` };
		});
		const provider = fakeProvider(summarize);
		const onProgress = vi.fn();

		const result = await summarizeLongTranscript(provider, { transcript: longTranscript, prompt: "USER_PROMPT" }, onProgress);

		expect(summarize).toHaveBeenCalledWith({ transcript: longTranscript, prompt: "USER_PROMPT" });
		expect(calls.length).toBeGreaterThan(1);

		const mapCalls = calls.slice(0, -1);
		const reduceCall = calls[calls.length - 1];

		for (const call of mapCalls) {
			expect(call.prompt).not.toBe("USER_PROMPT");
			expect(longTranscript).toContain(call.transcript);
		}

		expect(reduceCall.prompt).toBe("USER_PROMPT");
		for (const call of mapCalls) {
			const chunkIndex = calls.indexOf(call);
			expect(reduceCall.transcript).toContain(`digest-${chunkIndex + 1}`);
		}

		expect(result.summary).toBe(`digest-${calls.length}`);
		expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("Combining"));
	});

	it("does not fall back for unrelated provider errors", async () => {
		const summarize = vi.fn(async (): Promise<SummaryResult> => {
			throw new Error("Summary generation failed (HTTP 401): unauthorized");
		});

		await expect(summarizeLongTranscript(fakeProvider(summarize), { transcript: "transcript", prompt: "prompt" })).rejects.toThrow(/HTTP 401/);
		expect(summarize).toHaveBeenCalledTimes(1);
	});

	it("compacts digests when the final reduce request is still oversized", async () => {
		const longTranscript = "paragraph. ".repeat(SUMMARY_CHUNK_THRESHOLD_CHARS / 5);
		let initialAttempt = true;
		let reduceAttempt = 0;
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => {
			if (initialAttempt) {
				initialAttempt = false;
				throw new SummaryRequestTooLargeError("full transcript exceeds context");
			}
			if (request.prompt === "USER_PROMPT" && reduceAttempt++ === 0) {
				throw new SummaryRequestTooLargeError("combined digest exceeds context");
			}
			if (request.prompt === "USER_PROMPT") return { summary: "final summary" };
			return { summary: request.transcript.length > 100_000 ? "digest ".repeat(1500) : "compact digest" };
		});

		const result = await summarizeLongTranscript(fakeProvider(summarize), { transcript: longTranscript, prompt: "USER_PROMPT" });

		expect(result.summary).toBe("final summary");
		expect(reduceAttempt).toBe(2);
	});
});
