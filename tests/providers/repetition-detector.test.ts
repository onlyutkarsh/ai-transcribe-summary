import { describe, expect, it } from "vitest";
import { hasRepetitionLoop } from "../../src/providers/repetition-detector";

describe("hasRepetitionLoop", () => {
	it("returns false for empty text", () => {
		expect(hasRepetitionLoop("")).toBe(false);
	});

	it("returns false for normal prose", () => {
		const text = "We discussed the roadmap for next quarter and agreed to revisit pricing after the trial period ends.";
		expect(hasRepetitionLoop(text)).toBe(false);
	});

	it("returns false when a phrase repeats fewer than the threshold", () => {
		const text = Array(7).fill("thank you").join(" ");
		expect(hasRepetitionLoop(text)).toBe(false);
	});

	it("detects a single word repeated at or above the threshold", () => {
		const text = Array(8).fill("okay").join(" ");
		expect(hasRepetitionLoop(text)).toBe(true);
	});

	it("detects a multi-word phrase repeated at or above the threshold", () => {
		const text = Array(8).fill("thank you so much").join(" ");
		expect(hasRepetitionLoop(text)).toBe(true);
	});

	it("is case-insensitive", () => {
		const text = Array(8)
			.fill(0)
			.map((_, i) => (i % 2 === 0 ? "Okay" : "okay"))
			.join(" ");
		expect(hasRepetitionLoop(text)).toBe(true);
	});

	it("does not flag legitimate repeated words that don't form a tight loop", () => {
		const text = "the the cat sat on the mat and the dog sat on the rug near the the door";
		expect(hasRepetitionLoop(text)).toBe(false);
	});

	it("resets the run when the repeated phrase changes", () => {
		const text = `${Array(4).fill("apple").join(" ")} ${Array(4).fill("banana").join(" ")}`;
		expect(hasRepetitionLoop(text)).toBe(false);
	});

	it("detects a repetition loop appearing mid-transcript, not just at the start", () => {
		const lead = "We covered the budget and timeline for the project. ";
		const loop = Array(8).fill("no no no").join(" ");
		expect(hasRepetitionLoop(lead + loop)).toBe(true);
	});
});
