import { AiTranscribeSummarySettings, transcriptionKeyReuseTarget } from "../settings";
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

/** Effective API key for a summary provider, honoring "Reuse transcription API key" when it's set and applicable to that provider's host. */
export function resolveSummaryApiKey(settings: AiTranscribeSummarySettings, providerId: "openai" | "openrouter"): string {
	if (settings.reuseWhisperKeyForSummary && transcriptionKeyReuseTarget(settings) === providerId) {
		return settings.providers[providerId].apiKey;
	}
	return settings.summaryProviders[providerId].apiKey;
}

export function createSummaryProvider(settings: AiTranscribeSummarySettings): SummaryProvider {
	switch (settings.summaryProvider) {
		case "openai": {
			const config = settings.summaryProviders.openai;
			return new OpenAiSummaryProvider("openai", { ...config, apiKey: resolveSummaryApiKey(settings, "openai") });
		}
		case "openrouter": {
			const config = settings.summaryProviders.openrouter;
			return new OpenAiSummaryProvider("openrouter", { ...config, apiKey: resolveSummaryApiKey(settings, "openrouter") });
		}
	}
}
