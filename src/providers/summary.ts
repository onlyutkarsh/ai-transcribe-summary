import type { SummaryProviderId } from "../settings";

export interface SummaryRequest {
	transcript: string;
	/** Rendered summaryPrompt from settings (default or user-customized). */
	prompt: string;
}

export interface SummaryResult {
	/** Structured Markdown: Overview / Topics Discussed / Decisions Made / Action Items / Open Questions. */
	summary: string;
}

/** One implementation per SummaryProviderId (openai, openrouter, anthropic, google). */
export interface SummaryProvider {
	readonly id: SummaryProviderId;
	summarize(request: SummaryRequest): Promise<SummaryResult>;
}
