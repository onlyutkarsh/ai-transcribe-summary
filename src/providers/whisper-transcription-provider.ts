import { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { chunkAtSilence, needsChunking } from "../audio/chunker";
import { logDebug } from "../log";
import { encodeMultipartFormData } from "./multipart";
import { hasRepetitionLoop } from "./repetition-detector";
import { RequestAbortedError, requestUrlWithTimeout } from "./request-timeout";
import { TranscriptionProvider, TranscriptionProviderId, TranscriptionRequest, TranscriptionResult } from "./transcription";

export interface WhisperProviderConfig {
	apiKey: string;
	baseUrl: string;
	/** API model name as sent to the API (e.g. "whisper-1", "whisper-large-v3"). */
	apiModel: string;
}

/** Whisper transcription response shape, narrowed to the fields this provider reads. */
interface WhisperResponseBody {
	error?: { message?: string };
	text?: string;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
/** Chunk uploads should complete well within this; a stalled connection must not hang the pipeline forever. */
const CHUNK_REQUEST_TIMEOUT_MS = 120_000;
/** Chunk uploads in flight at once - bounded rather than unbounded so memory (each chunk's encoded WAV bytes held until its request completes) and provider rate-limit exposure stay modest on meetings with many chunks. */
const MAX_CONCURRENT_CHUNK_UPLOADS = 3;

const PROVIDER_LABELS: Record<TranscriptionProviderId, string> = {
	openai: "OpenAI",
	openrouter: "OpenRouter",
};

/** Whisper identifies the upload format from the filename extension, not the multipart Content-Type - must match the piece's actual encoding (webm/ogg from the recorder, wav from the chunker). */
function extensionForMimeType(mimeType: string): string {
	if (mimeType.includes("wav")) return "wav";
	if (mimeType.includes("ogg")) return "ogg";
	return "webm";
}

/** Whisper-compatible transcription over the OpenAI-shaped upload API - used for both the OpenAI and OpenRouter transcription providers, which differ only in apiKey/baseUrl/apiModel. */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
	constructor(readonly id: TranscriptionProviderId, private config: WhisperProviderConfig) {}

	async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
		if (!this.config.apiKey) {
			throw new Error(`${PROVIDER_LABELS[this.id]} API key is not set. Add it in Settings under "${PROVIDER_LABELS[this.id]}".`);
		}

		const onProgress = request.onProgress ?? (() => {});
		const signal = request.signal;

		const chunked = needsChunking(request.audio);
		logDebug("whisper: audio size", request.audio.size, "bytes, chunking:", chunked);

		const options = { vocabularyHints: request.vocabularyHints, language: request.language };

		let texts: string[];
		if (chunked) {
			// chunkAtSilence yields pieces one at a time rather than building the full array up
			// front, so at most MAX_CONCURRENT_CHUNK_UPLOADS encoded WAV chunks are resident in
			// memory alongside the decoded PCM buffer, not every chunk in the recording at once.
			texts = await this.transcribeChunksConcurrently(chunkAtSilence(request.audio), options, onProgress, signal);
		} else {
			const piece = { data: await request.audio.arrayBuffer(), mimeType: request.audio.type || request.mimeType };
			texts = [await this.transcribeOnePiece(piece, options, 0, signal)];
		}

		logDebug("whisper: piece count", texts.length);

		const text = texts.join(" ").trim();
		const repetitionWarning = hasRepetitionLoop(text);
		logDebug("whisper: transcription complete", { textLength: text.length, repetitionWarning });
		return { text, repetitionWarning };
	}

	/**
	 * Consumes `pieces` and uploads each one, at most MAX_CONCURRENT_CHUNK_UPLOADS in flight at
	 * a time - a fixed-size worker pool rather than draining the generator into an array first
	 * and firing everything at once, so at most a handful of chunks' encoded bytes are resident
	 * simultaneously regardless of how many chunks the recording has. Results are returned in
	 * original chunk order even though completion order may differ.
	 */
	private async transcribeChunksConcurrently(
		pieces: AsyncIterable<{ data: ArrayBuffer; mimeType: string }, void, unknown>,
		options: { vocabularyHints: string; language: string },
		onProgress: (status: string) => void,
		signal: AbortSignal | undefined
	): Promise<string[]> {
		const iterator = pieces[Symbol.asyncIterator]();
		const results: string[] = [];
		let nextIndex = 0;
		let completedCount = 0;

		// chunkAtSilence doesn't expose a chunk total up front (chunks are found lazily, one at
		// a time), and workers upload concurrently, so completion order doesn't match chunk
		// order either - "Transcribed N chunks so far" is the only accurate progress shape
		// available without pre-draining the generator, which would defeat its memory-bounded
		// point (see the comment at the call site).
		const worker = async () => {
			for (;;) {
				if (signal?.aborted) throw new RequestAbortedError();

				const { value: piece, done } = await iterator.next();
				if (done) return;

				const index = nextIndex++;
				results[index] = await this.transcribeOnePiece(piece, options, index, signal);
				completedCount++;
				onProgress(`Transcribed ${completedCount} chunk${completedCount === 1 ? "" : "s"} so far`);
			}
		};

		const workers = Array.from({ length: MAX_CONCURRENT_CHUNK_UPLOADS }, () => worker());
		await Promise.all(workers);

		return results;
	}

	private async transcribeOnePiece(
		piece: { data: ArrayBuffer; mimeType: string },
		options: { vocabularyHints: string; language: string },
		index: number,
		signal: AbortSignal | undefined
	): Promise<string> {
		const extension = extensionForMimeType(piece.mimeType);
		const { contentType, body } = encodeMultipartFormData(
			[
				{ name: "model", value: this.config.apiModel },
				...(options.vocabularyHints ? [{ name: "prompt", value: options.vocabularyHints }] : []),
				...(options.language ? [{ name: "language", value: options.language }] : []),
			],
			[{ name: "file", filename: `audio-${index}.${extension}`, mimeType: piece.mimeType, data: piece.data }]
		);

		const url = `${this.config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

		logDebug(`whisper: uploading chunk ${index + 1}`, { bytes: piece.data.byteLength, model: this.config.apiModel });
		const startedAt = Date.now();
		const response = await this.requestWithRetry(
			{
				url,
				method: "POST",
				contentType,
				body,
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				throw: false,
			},
			signal
		);
		logDebug(`whisper: chunk ${index + 1} responded`, { status: response.status, durationMs: Date.now() - startedAt });

		const json = response.json as WhisperResponseBody | undefined;

		if (response.status >= 400) {
			const detail = json?.error?.message ?? response.text;
			throw new Error(`Whisper transcription failed on chunk ${index + 1} (HTTP ${response.status}): ${detail}`);
		}

		return typeof json?.text === "string" ? json.text : "";
	}

	/** Retries on thrown errors (network failures) and on HTTP 429/5xx responses (rate limits, transient server errors) - anything else, including a user-initiated abort, is returned/thrown as-is for the caller to handle. */
	private async requestWithRetry(params: RequestUrlParam, signal: AbortSignal | undefined): Promise<RequestUrlResponse> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const response = await requestUrlWithTimeout(params, CHUNK_REQUEST_TIMEOUT_MS, signal);
				if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES - 1) {
					logDebug(`whisper: request returned HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`);
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
					continue;
				}
				return response;
			} catch (error) {
				if (error instanceof RequestAbortedError) throw error;
				lastError = error;
				if (attempt < MAX_RETRIES - 1) {
					logDebug(`whisper: request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`, error);
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
				}
			}
		}
		throw lastError;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
