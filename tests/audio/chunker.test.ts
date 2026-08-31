import { describe, expect, it } from "vitest";
import { findSilenceSplitPoints } from "../../src/audio/chunker";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // mono, matches chunker's bytesPerSample = 2 * numberOfChannels

/** Minimal AudioBuffer stand-in - findSilenceSplitPoints only reads these properties/methods. */
function fakeMonoBuffer(channelData: Float32Array): AudioBuffer {
	return {
		numberOfChannels: 1,
		sampleRate: SAMPLE_RATE,
		length: channelData.length,
		getChannelData: () => channelData,
	} as unknown as AudioBuffer;
}

function toneSeconds(seconds: number, amplitude = 0.5): Float32Array {
	const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
	for (let i = 0; i < samples.length; i++) {
		samples[i] = amplitude * Math.sin(i * 0.3);
	}
	return samples;
}

function silenceSeconds(seconds: number): Float32Array {
	return new Float32Array(Math.floor(seconds * SAMPLE_RATE));
}

function concat(...parts: Float32Array[]): Float32Array {
	const total = parts.reduce((sum, p) => sum + p.length, 0);
	const out = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

describe("findSilenceSplitPoints", () => {
	it("returns no split points when the buffer is shorter than one chunk", () => {
		const buffer = fakeMonoBuffer(toneSeconds(2));
		const targetChunkBytes = 10 * SAMPLE_RATE * BYTES_PER_SAMPLE; // way bigger than the buffer
		expect(findSilenceSplitPoints(buffer, targetChunkBytes)).toEqual([]);
	});

	it("splits at a silence gap near the target boundary instead of exactly on it", () => {
		// 4s tone, 1s silence (centered near the 5s target), 4s tone.
		const data = concat(toneSeconds(4), silenceSeconds(1), toneSeconds(4));
		const buffer = fakeMonoBuffer(data);
		const targetChunkBytes = 5 * SAMPLE_RATE * BYTES_PER_SAMPLE; // target ~5s in

		const splitPoints = findSilenceSplitPoints(buffer, targetChunkBytes);

		expect(splitPoints).toHaveLength(1);
		const silenceStart = 4 * SAMPLE_RATE;
		const silenceEnd = 5 * SAMPLE_RATE;
		expect(splitPoints[0]).toBeGreaterThanOrEqual(silenceStart);
		expect(splitPoints[0]).toBeLessThanOrEqual(silenceEnd);
	});

	it("falls back to a hard cut at the target when no nearby silence gap exists", () => {
		// Continuous tone for the whole buffer - no silence anywhere.
		const data = toneSeconds(10);
		const buffer = fakeMonoBuffer(data);
		const targetChunkBytes = 5 * SAMPLE_RATE * BYTES_PER_SAMPLE;

		const splitPoints = findSilenceSplitPoints(buffer, targetChunkBytes);

		expect(splitPoints).toHaveLength(1);
		expect(splitPoints[0]).toBe(5 * SAMPLE_RATE);
	});

	it("produces multiple split points for a buffer spanning several target-sized chunks", () => {
		const data = concat(toneSeconds(5), silenceSeconds(1), toneSeconds(5), silenceSeconds(1), toneSeconds(5));
		const buffer = fakeMonoBuffer(data);
		const targetChunkBytes = 6 * SAMPLE_RATE * BYTES_PER_SAMPLE;

		const splitPoints = findSilenceSplitPoints(buffer, targetChunkBytes);

		expect(splitPoints).toHaveLength(2);
		expect(splitPoints[0]).toBeLessThan(splitPoints[1]);
	});

	it("ignores a silence gap shorter than the minimum gap duration", () => {
		// Only 0.1s of silence near the target (min gap is 0.5s) - should fall back to a hard cut.
		const data = concat(toneSeconds(4.95), silenceSeconds(0.1), toneSeconds(4.95));
		const buffer = fakeMonoBuffer(data);
		const targetChunkBytes = 5 * SAMPLE_RATE * BYTES_PER_SAMPLE;

		const splitPoints = findSilenceSplitPoints(buffer, targetChunkBytes);

		expect(splitPoints).toHaveLength(1);
		expect(splitPoints[0]).toBe(5 * SAMPLE_RATE);
	});
});
