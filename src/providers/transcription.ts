import type { TranscriptionProviderId } from "../settings";

export type { TranscriptionProviderId };

export interface TranscriptionRequest {
	/** Recorded (or right-click-retried) audio file. */
	audio: Blob;
	mimeType: string;
	/** Comma-separated names/jargon from settings, passed through where the provider supports it. */
	vocabularyHints: string;
	/** Called with a short status string as a provider makes progress (e.g. per-chunk upload progress). */
	onProgress?: (status: string) => void;
}

export interface TranscriptionResult {
	text: string;
	/** True if repetition-loop scanning (PRD Tier 1) flagged abnormally repeated phrases in `text`. */
	repetitionWarning: boolean;
}

/**
 * One implementation per TranscriptionProviderId (openai, openrouter - both
 * Whisper-compatible). A provider is responsible for its own size-limit
 * handling internally (e.g. Whisper's silence-aware chunking + stitching);
 * callers only see one request in, one stitched result out.
 */
export interface TranscriptionProvider {
	readonly id: TranscriptionProviderId;
	transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
