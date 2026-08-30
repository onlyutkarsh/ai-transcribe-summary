import { AiTranscribeSummarySettings, resolveWhisperModelOption, whisperKeyReuseTarget } from "../settings";
import { OpenAiSummaryProvider } from "./openai-summary-provider";
import { SummaryProvider } from "./summary";
import { TranscriptionProvider } from "./transcription";
import { WhisperTranscriptionProvider } from "./whisper-transcription-provider";

export function createTranscriptionProvider(settings: AiTranscribeSummarySettings): TranscriptionProvider {
	switch (settings.transcriptionProvider) {
		case "whisper": {
			const config = settings.providers.whisper;
			return new WhisperTranscriptionProvider({
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				apiModel: resolveWhisperModelOption(config.model).apiModel,
			});
		}
		case "assemblyai":
			throw new Error("AssemblyAI transcription is not implemented yet - select Whisper in Settings.");
	}
}

/** Effective API key for a summary provider, honoring "Reuse Whisper API key" when it's set and applicable to that provider's host. */
export function resolveSummaryApiKey(settings: AiTranscribeSummarySettings, providerId: "openai" | "openrouter"): string {
	if (settings.reuseWhisperKeyForSummary && whisperKeyReuseTarget(settings) === providerId) {
		return settings.providers.whisper.apiKey;
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
		case "anthropic":
		case "google":
			throw new Error(`${settings.summaryProvider} summary generation is not implemented yet - select OpenAI or OpenRouter in Settings.`);
	}
}
