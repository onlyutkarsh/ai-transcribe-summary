import { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { logDebug } from "../log";
import { RequestAbortedError, requestUrlWithTimeout } from "./request-timeout";
import { SUMMARY_PROVIDER_SCHEMA, type SummaryProviderId } from "../settings";
import { SummaryProvider, SummaryRequest, SummaryResult } from "./summary";

/** Summary requests can legitimately take a while on long transcripts, but must not hang forever. */
const SUMMARY_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

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

		const step = request.step ?? "summary";
		const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
		logDebug(`${step}: requesting`, { provider: this.id, model: this.config.model, transcriptLength: request.transcript.length });
		const startedAt = Date.now();
		const response = await this.requestWithRetry(
			{
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
			},
			request.signal,
			step
		);
		logDebug(`${step}: responded`, { status: response.status, durationMs: Date.now() - startedAt });

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

	/** Retries on thrown errors (network failures) and on HTTP 429/5xx responses (rate limits, transient server errors) - anything else, including a user-initiated abort, is returned/thrown as-is for the caller to handle. */
	private async requestWithRetry(params: RequestUrlParam, signal: AbortSignal | undefined, step: "summary" | "cleanup"): Promise<RequestUrlResponse> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const response = await requestUrlWithTimeout(params, SUMMARY_REQUEST_TIMEOUT_MS, signal);
				if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES - 1) {
					logDebug(`${step}: request returned HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`);
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
					continue;
				}
				return response;
			} catch (error) {
				if (error instanceof RequestAbortedError) throw error;
				lastError = error;
				if (attempt < MAX_RETRIES - 1) {
					logDebug(`${step}: request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`, error);
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
