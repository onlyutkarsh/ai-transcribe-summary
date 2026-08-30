import { RequestUrlResponse, requestUrl } from "obsidian";
import { chunkAtSilence, needsChunking } from "../audio/chunker";
import { logDebug } from "../pipeline";
import { encodeMultipartFormData } from "./multipart";
import { hasRepetitionLoop } from "./repetition-detector";
import { TranscriptionProvider, TranscriptionRequest, TranscriptionResult } from "./transcription";

export interface WhisperProviderConfig {
	apiKey: string;
	baseUrl: string;
	/** API model name (e.g. "whisper-1", "whisper-large-v3") - distinct from the settings model id, which also encodes the host. */
	apiModel: string;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/** Whisper identifies the upload format from the filename extension, not the multipart Content-Type - must match the piece's actual encoding (webm/ogg from the recorder, wav from the chunker). */
function extensionForMimeType(mimeType: string): string {
	if (mimeType.includes("wav")) return "wav";
	if (mimeType.includes("ogg")) return "ogg";
	return "webm";
}

export class WhisperTranscriptionProvider implements TranscriptionProvider {
	readonly id = "whisper" as const;

	constructor(private config: WhisperProviderConfig) {}

	async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
		if (!this.config.apiKey) {
			throw new Error("Whisper API key is not set. Add it in Settings under Whisper (OpenAI / OpenRouter).");
		}

		const onProgress = request.onProgress ?? (() => {});

		const chunked = needsChunking(request.audio);
		logDebug("whisper: audio size", request.audio.size, "bytes, chunking:", chunked);

		// chunkAtSilence yields pieces one at a time rather than building the full array up
		// front, so at most one encoded WAV chunk is resident in memory alongside the decoded
		// PCM buffer - important for long recordings where holding every chunk simultaneously
		// risks exhausting memory.
		const pieces: AsyncIterable<{ data: ArrayBuffer; mimeType: string }> = chunked
			? chunkAtSilence(request.audio)
			: (async function* () {
					yield { data: await request.audio.arrayBuffer(), mimeType: request.audio.type || request.mimeType };
			  })();

		const texts: string[] = [];
		let index = 0;
		for await (const piece of pieces) {
			if (chunked) {
				onProgress(`Transcribing chunk ${index + 1}`);
			}
			texts.push(await this.transcribeOnePiece(piece, request.vocabularyHints, index));
			index++;
		}

		logDebug("whisper: piece count", index);

		const text = texts.join(" ").trim();
		const repetitionWarning = hasRepetitionLoop(text);
		logDebug("whisper: transcription complete", { textLength: text.length, repetitionWarning });
		return { text, repetitionWarning };
	}

	private async transcribeOnePiece(piece: { data: ArrayBuffer; mimeType: string }, vocabularyHints: string, index: number): Promise<string> {
		const extension = extensionForMimeType(piece.mimeType);
		const { contentType, body } = encodeMultipartFormData(
			[
				{ name: "model", value: this.config.apiModel },
				...(vocabularyHints ? [{ name: "prompt", value: vocabularyHints }] : []),
			],
			[{ name: "file", filename: `audio-${index}.${extension}`, mimeType: piece.mimeType, data: piece.data }]
		);

		const url = `${this.config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

		logDebug(`whisper: uploading chunk ${index + 1}`, { bytes: piece.data.byteLength, model: this.config.apiModel });
		const startedAt = Date.now();
		const response = await this.requestWithRetry({
			url,
			method: "POST",
			contentType,
			body,
			headers: { Authorization: `Bearer ${this.config.apiKey}` },
			throw: false,
		});
		logDebug(`whisper: chunk ${index + 1} responded`, { status: response.status, durationMs: Date.now() - startedAt });

		if (response.status >= 400) {
			const detail = response.json?.error?.message ?? response.text;
			throw new Error(`Whisper transcription failed on chunk ${index + 1} (HTTP ${response.status}): ${detail}`);
		}

		return typeof response.json?.text === "string" ? response.json.text : "";
	}

	/** Retries on thrown errors (network failures) and on HTTP 429/5xx responses (rate limits, transient server errors) - anything else is returned as-is for the caller to turn into a terminal error. */
	private async requestWithRetry(params: Parameters<typeof requestUrl>[0]): Promise<RequestUrlResponse> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const response = await requestUrl(params);
				if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES - 1) {
					logDebug(`whisper: request returned HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`);
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
					continue;
				}
				return response;
			} catch (error) {
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
	return new Promise((resolve) => setTimeout(resolve, ms));
}
