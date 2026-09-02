import type { SummaryProviderId } from "../settings";

export interface SummaryRequest {
	transcript: string;
	/** Rendered summaryPrompt from settings (default or user-customized). */
	prompt: string;
	/** When aborted, the provider stops waiting on/starting further requests and rejects with RequestAbortedError. */
	signal?: AbortSignal;
	/** Which pipeline step this call belongs to - log-only, lets shared providers (used for both cleanup and summary) label their logs correctly. Defaults to "summary" when omitted. */
	step?: "summary" | "cleanup";
}

export interface SummaryResult {
	/** Structured Markdown: Overview / Topics Discussed / Decisions Made / Action Items / Open Questions. */
	summary: string;
}

/** One implementation per SummaryProviderId (openai, openrouter, gemini). */
export interface SummaryProvider {
	readonly id: SummaryProviderId;
	summarize(request: SummaryRequest): Promise<SummaryResult>;
}
