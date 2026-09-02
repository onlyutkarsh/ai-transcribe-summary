import { logDebug } from "../log";
import { RequestAbortedError } from "./request-timeout";
import { splitTranscriptForSummary } from "./transcript-splitter";
import { SummaryProvider, SummaryRequest, SummaryResult } from "./summary";

/** Called with a short status string as map-reduce summarization makes progress (e.g. per-chunk digest progress). */
export type SummarizeProgressCallback = (status: string) => void;

/** Internal, not user-configurable - extracts a neutral factual digest per chunk rather than the user's structured summary format, since the map stage's output is intermediate input to the final reduce call, not the final summary itself. */
const MAP_CHUNK_PROMPT = `You are extracting a factual digest from one part of a longer meeting transcript, to be combined with digests of the other parts later. Do not produce a final summary or use any particular format.

List, in plain prose or a simple list, every topic discussed, decision made, action item mentioned (with owner/due date only if explicitly stated), and open question or follow-up raised in this part of the transcript.

Never invent names, owners, dates, or facts not explicitly present in this text. Be concise but do not omit any concrete decision or action item.`;

/**
 * Summarizes a transcript that may be too long to fit in one call: transcripts
 * at or under SUMMARY_CHUNK_THRESHOLD_CHARS go through `provider.summarize`
 * exactly as before (single call, request.prompt as-is). Longer transcripts
 * are split into chunks, each digested independently (map), then the user's
 * real summary prompt is run once more over the joined digests (reduce) to
 * produce the final structured summary - keeping the shape of the input to
 * the final call within the same size budget regardless of meeting length.
 */
export async function summarizeLongTranscript(
	provider: SummaryProvider,
	request: SummaryRequest,
	onProgress: SummarizeProgressCallback = () => {}
): Promise<SummaryResult> {
	const chunks = splitTranscriptForSummary(request.transcript);
	if (chunks.length <= 1) {
		return provider.summarize(request);
	}

	const step = request.step ?? "summary";
	logDebug(`${step}: splitting transcript for map-reduce`, { transcriptLength: request.transcript.length, chunkCount: chunks.length });

	const digests: string[] = [];
	for (let i = 0; i < chunks.length; i++) {
		if (request.signal?.aborted) throw new RequestAbortedError();
		onProgress(`Summarizing part ${i + 1} of ${chunks.length}`);
		const digestResult = await provider.summarize({ transcript: chunks[i], prompt: MAP_CHUNK_PROMPT, signal: request.signal, step: request.step });
		digests.push(digestResult.summary.trim());
	}

	if (request.signal?.aborted) throw new RequestAbortedError();
	onProgress("Combining summary");
	const combinedDigest = digests.map((digest, i) => `## Part ${i + 1}\n\n${digest}`).join("\n\n");
	logDebug(`${step}: combining digests for map-reduce`, { digestCount: digests.length, combinedLength: combinedDigest.length });

	return provider.summarize({ transcript: combinedDigest, prompt: request.prompt, signal: request.signal, step: request.step });
}
