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

		const pieces = chunked
			? await chunkAtSilence(request.audio)
			: [{ data: await request.audio.arrayBuffer(), mimeType: request.audio.type || request.mimeType }];

		logDebug("whisper: piece count", pieces.length);

		const texts: string[] = [];
		for (const [index, piece] of pieces.entries()) {
			if (pieces.length > 1) {
				onProgress(`Transcribing chunk ${index + 1}/${pieces.length}`);
			}
			texts.push(await this.transcribeOnePiece(piece, request.vocabularyHints, index, pieces.length));
		}

		const text = texts.join(" ").trim();
		const repetitionWarning = hasRepetitionLoop(text);
		logDebug("whisper: transcription complete", { textLength: text.length, repetitionWarning });
		return { text, repetitionWarning };
	}

	private async transcribeOnePiece(
		piece: { data: ArrayBuffer; mimeType: string },
		vocabularyHints: string,
		index: number,
		total: number
	): Promise<string> {
		const extension = piece.mimeType.includes("wav") ? "wav" : "webm";
		const { contentType, body } = encodeMultipartFormData(
			[
				{ name: "model", value: this.config.apiModel },
				...(vocabularyHints ? [{ name: "prompt", value: vocabularyHints }] : []),
			],
			[{ name: "file", filename: `audio-${index}.${extension}`, mimeType: piece.mimeType, data: piece.data }]
		);

		const url = `${this.config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

		logDebug(`whisper: uploading chunk ${index + 1}/${total}`, { bytes: piece.data.byteLength, model: this.config.apiModel });
		const startedAt = Date.now();
		const response = await this.requestWithRetry({
			url,
			method: "POST",
			contentType,
			body,
			headers: { Authorization: `Bearer ${this.config.apiKey}` },
			throw: false,
		});
		logDebug(`whisper: chunk ${index + 1}/${total} responded`, { status: response.status, durationMs: Date.now() - startedAt });

		if (response.status >= 400) {
			const detail = response.json?.error?.message ?? response.text;
			throw new Error(`Whisper transcription failed on chunk ${index + 1}/${total} (HTTP ${response.status}): ${detail}`);
		}

		return typeof response.json?.text === "string" ? response.json.text : "";
	}

	private async requestWithRetry(params: Parameters<typeof requestUrl>[0]): Promise<RequestUrlResponse> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				return await requestUrl(params);
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
