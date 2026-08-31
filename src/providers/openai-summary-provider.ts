import { requestUrl } from "obsidian";
import { logDebug } from "../log";
import { SUMMARY_PROVIDER_SCHEMA, type SummaryProviderId } from "../settings";
import { SummaryProvider, SummaryRequest, SummaryResult } from "./summary";

export interface OpenAiSummaryProviderConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature: number;
}

/** Chat Completions response shape, narrowed to the fields this provider reads. */
interface ChatCompletionsResponseBody {
	error?: { message?: string };
	choices?: { message?: { content?: string } }[];
}

/**
 * Appended to every system prompt (default or user-customized, including the
 * internal map-reduce digest prompt) so the LLM doesn't default to English
 * for a non-English transcript - none of the prompts otherwise say what
 * language to respond in, and an English-written prompt biases most models
 * toward English output regardless of the input transcript's language.
 */
const LANGUAGE_MATCH_INSTRUCTION = "\n\nWrite your response in the same language as the transcript below, not the language of these instructions.";

/** Backs "openai", "openrouter", and "gemini" - all three expose the same Chat Completions request/response shape (Gemini via its OpenAI-compatible endpoint). */
export class OpenAiSummaryProvider implements SummaryProvider {
	constructor(readonly id: SummaryProviderId, private config: OpenAiSummaryProviderConfig) {}

	async summarize(request: SummaryRequest): Promise<SummaryResult> {
		if (!this.config.apiKey) {
			throw new Error(`${SUMMARY_PROVIDER_SCHEMA[this.id].label} API key is not set. Add it in Settings under Summary generation.`);
		}

		const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
		logDebug(`${this.id} summary: requesting`, { model: this.config.model, transcriptLength: request.transcript.length });
		const startedAt = Date.now();
		const response = await requestUrl({
			url,
			method: "POST",
			contentType: "application/json",
			headers: { Authorization: `Bearer ${this.config.apiKey}` },
			throw: false,
			body: JSON.stringify({
				model: this.config.model,
				temperature: this.config.temperature,
				messages: [
					{ role: "system", content: request.prompt + LANGUAGE_MATCH_INSTRUCTION },
					{ role: "user", content: request.transcript },
				],
			}),
		});
		logDebug(`${this.id} summary: responded`, { status: response.status, durationMs: Date.now() - startedAt });

		const json = response.json as ChatCompletionsResponseBody | undefined;

		if (response.status >= 400) {
			const detail = json?.error?.message ?? response.text;
			throw new Error(`Summary generation failed (HTTP ${response.status}): ${detail}`);
		}

		const summary = json?.choices?.[0]?.message?.content;
		if (typeof summary !== "string" || !summary.trim()) {
			throw new Error("Summary generation returned an empty response.");
		}

		return { summary };
	}
}
