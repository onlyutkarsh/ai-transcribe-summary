import { describe, expect, it } from "vitest";
import { splitTranscriptForSummary } from "../../src/providers/transcript-splitter";

describe("splitTranscriptForSummary", () => {
	it("returns the transcript unchanged when it already fits in one chunk", () => {
		const transcript = "Short meeting transcript.";
		expect(splitTranscriptForSummary(transcript, 1000)).toEqual([transcript]);
	});

	it("splits at paragraph boundaries when the transcript exceeds the limit", () => {
		const paragraphs = ["First paragraph about topic A.", "Second paragraph about topic B.", "Third paragraph about topic C."];
		const transcript = paragraphs.join("\n\n");
		const maxChunkChars = paragraphs[0].length + paragraphs[1].length + 2; // room for exactly two paragraphs

		const chunks = splitTranscriptForSummary(transcript, maxChunkChars);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxChunkChars);
		}
		expect(chunks.join("\n\n")).toContain("topic A");
		expect(chunks.join("\n\n")).toContain("topic C");
	});

	it("falls back to sentence boundaries for a paragraph larger than the chunk limit", () => {
		const sentences = ["This is sentence one.", "This is sentence two.", "This is sentence three."];
		const paragraph = sentences.join(" ");
		const maxChunkChars = sentences[0].length + sentences[1].length + 1;

		const chunks = splitTranscriptForSummary(paragraph, maxChunkChars);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxChunkChars);
		}
	});

	it("hard-cuts a single run-on sentence longer than the chunk limit", () => {
		const longSentence = "word ".repeat(50).trim() + ".";
		const maxChunkChars = 20;

		const chunks = splitTranscriptForSummary(longSentence, maxChunkChars);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(maxChunkChars);
		}
		expect(chunks.join("")).toBe(longSentence);
	});

	it("never drops content across chunk boundaries", () => {
		const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some content about item ${i}.`);
		const transcript = paragraphs.join("\n\n");

		const chunks = splitTranscriptForSummary(transcript, 150);

		for (const paragraph of paragraphs) {
			expect(chunks.some((chunk) => chunk.includes(paragraph))).toBe(true);
		}
	});
});
