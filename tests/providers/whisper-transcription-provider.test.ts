import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperTranscriptionProvider } from "../../src/providers/whisper-transcription-provider";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));

vi.mock("obsidian", () => ({
	requestUrl: requestUrlMock,
	Notice: class {
		constructor(_message: string, _duration?: number) {}
	},
}));

vi.mock("../../src/audio/chunker", () => ({
	needsChunking: () => true,
	chunkAtSilence: async function* (blob: Blob) {
		const chunkCount = (blob as unknown as { chunkCount: number }).chunkCount;
		for (let i = 0; i < chunkCount; i++) {
			yield { data: new ArrayBuffer(1), mimeType: "audio/wav" };
		}
	},
}));

function fakeChunkedBlob(chunkCount: number): Blob {
	return { chunkCount } as unknown as Blob;
}

/** A controllable promise whose resolution the test drives explicitly, to observe in-flight concurrency. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => (resolve = res));
	return { promise, resolve };
}

beforeEach(() => {
	requestUrlMock.mockReset();
});

describe("WhisperTranscriptionProvider concurrent chunk uploads", () => {
	it("returns chunk texts in original order even when they complete out of order", async () => {
		const deferredByIndex = [deferred<void>(), deferred<void>(), deferred<void>()];
		let callIndex = 0;

		requestUrlMock.mockImplementation(async () => {
			const index = callIndex++;
			await deferredByIndex[index].promise;
			return { status: 200, json: { text: `text-${index}` } };
		});

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		const resultPromise = provider.transcribe({ audio: fakeChunkedBlob(3), mimeType: "audio/webm", vocabularyHints: "", language: "" });

		// Resolve out of order: chunk 2 first, then 0, then 1.
		deferredByIndex[2].resolve();
		await Promise.resolve();
		deferredByIndex[0].resolve();
		await Promise.resolve();
		deferredByIndex[1].resolve();

		const result = await resultPromise;
		expect(result.text).toBe("text-0 text-1 text-2");
	});

	it("never has more than MAX_CONCURRENT_CHUNK_UPLOADS (3) requests in flight at once", async () => {
		const totalChunks = 7;
		let inFlight = 0;
		let maxInFlight = 0;
		const releases: (() => void)[] = [];

		requestUrlMock.mockImplementation(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => releases.push(resolve));
			inFlight--;
			return { status: 200, json: { text: "chunk" } };
		});

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		const resultPromise = provider.transcribe({ audio: fakeChunkedBlob(totalChunks), mimeType: "audio/webm", vocabularyHints: "", language: "" });

		// Drain releases as they show up until every chunk has been processed.
		let released = 0;
		while (released < totalChunks) {
			if (releases.length > 0) {
				releases.shift()!();
				released++;
			}
			await Promise.resolve();
		}

		await resultPromise;
		expect(maxInFlight).toBeLessThanOrEqual(3);
		expect(maxInFlight).toBeGreaterThan(1); // sanity check that it actually ran concurrently, not sequentially
	});
});
