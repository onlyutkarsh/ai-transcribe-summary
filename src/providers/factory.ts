import { AiTranscribeSummarySettings, SummaryProviderId, transcriptionKeyReuseTarget } from "../settings";
import { OpenAiSummaryProvider } from "./openai-summary-provider";
import { SummaryProvider } from "./summary";
import { TranscriptionProvider } from "./transcription";
import { WhisperTranscriptionProvider } from "./whisper-transcription-provider";

export function createTranscriptionProvider(settings: AiTranscribeSummarySettings): TranscriptionProvider {
	const providerId = settings.transcriptionProvider;
	const config = settings.providers[providerId];
	return new WhisperTranscriptionProvider(providerId, {
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		apiModel: config.model,
	});
}

/** Effective API key for a summary provider, honoring "Reuse transcription API key" when it's set and applicable to that provider's host. Gemini has no transcription counterpart, so reuse never applies to it. */
export function resolveSummaryApiKey(settings: AiTranscribeSummarySettings, providerId: SummaryProviderId): string {
	if (providerId !== "gemini" && settings.reuseWhisperKeyForSummary && transcriptionKeyReuseTarget(settings) === providerId) {
		return settings.providers[providerId].apiKey;
	}
	return settings.summaryProviders[providerId].apiKey;
}

export function createSummaryProvider(settings: AiTranscribeSummarySettings): SummaryProvider {
	const providerId = settings.summaryProvider;
	const config = settings.summaryProviders[providerId];
	return new OpenAiSummaryProvider(providerId, { ...config, apiKey: resolveSummaryApiKey(settings, providerId) });
}
