import { logDebug } from "../log";
import { RequestAbortedError } from "./request-timeout";
import { splitTranscriptForSummary } from "./transcript-splitter";
import { SummaryProvider, SummaryRequest } from "./summary";

/**
 * Cleanup rewrites the whole transcript, so its output is as long as its input - unlike a summary,
 * a long meeting can't go out as one request without running past the model's output token cap
 * (silently truncating the transcript) and the request timeout (paying for a response that is
 * never received). ~20K chars is ~5K output tokens: within every supported model's output limit
 * and comfortably returned well inside the timeout.
 */
export const CLEANUP_CHUNK_CHARS = 20_000;

/** Cleans `request.transcript` piece by piece; a piece whose cleanup comes back empty keeps its original text rather than dropping that part of the meeting. */
export async function cleanUpTranscript(
	provider: SummaryProvider,
	request: SummaryRequest,
	onProgress: (status: string) => void = () => {}
): Promise<string> {
	const chunks = splitTranscriptForSummary(request.transcript, CLEANUP_CHUNK_CHARS);
	if (chunks.length > 1) {
		logDebug("cleanup: splitting transcript", { transcriptLength: request.transcript.length, chunkCount: chunks.length });
	}

	const cleaned: string[] = [];
	for (let i = 0; i < chunks.length; i++) {
		if (request.signal?.aborted) throw new RequestAbortedError();
		if (chunks.length > 1) onProgress(`Cleaning up part ${i + 1} of ${chunks.length}`);
		const result = await provider.summarize({ ...request, transcript: chunks[i] });
		cleaned.push(result.summary.trim() || chunks[i]);
	}
	return cleaned.join("\n\n");
}
