import { describe, expect, it, vi } from "vitest";
import { summarizeLongTranscript } from "../../src/providers/map-reduce-summarizer";
import { SummaryProvider, SummaryRequest, SummaryResult } from "../../src/providers/summary";

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

	it("map-reduces a long transcript: one call per chunk plus one final reduce call using the user's prompt", async () => {
		const longTranscript = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`.repeat(2000)).join("\n\n");
		const calls: SummaryRequest[] = [];
		const summarize = vi.fn(async (request: SummaryRequest): Promise<SummaryResult> => {
			calls.push(request);
			return { summary: `digest-${calls.length}` };
		});
		const provider = fakeProvider(summarize);
		const onProgress = vi.fn();

		const result = await summarizeLongTranscript(provider, { transcript: longTranscript, prompt: "USER_PROMPT" }, onProgress);

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
});
