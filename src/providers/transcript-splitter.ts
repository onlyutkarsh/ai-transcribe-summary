/** Above this length a transcript is map-reduced (per-chunk digest, then one final summarize over the digests) instead of sent as a single message - long transcripts risk exceeding the model's context window and lose quality when key points are buried mid-input. ~45K chars is a conservative ~11-12K token budget, safely under even small-context models once the prompt and output are accounted for. */
export const SUMMARY_CHUNK_THRESHOLD_CHARS = 45_000;

/**
 * Splits `transcript` into chunks no larger than `maxChunkChars`, breaking at
 * paragraph boundaries where possible and falling back to sentence or hard
 * character breaks so no chunk ever exceeds the limit. Returns `[transcript]`
 * unchanged when it already fits in one chunk.
 */
export function splitTranscriptForSummary(transcript: string, maxChunkChars = SUMMARY_CHUNK_THRESHOLD_CHARS): string[] {
	if (transcript.length <= maxChunkChars) {
		return [transcript];
	}

	const paragraphs = transcript.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = "";

	for (const paragraph of paragraphs) {
		const withParagraph = current ? `${current}\n\n${paragraph}` : paragraph;
		if (withParagraph.length <= maxChunkChars) {
			current = withParagraph;
			continue;
		}

		if (current) {
			chunks.push(current);
			current = "";
		}

		if (paragraph.length <= maxChunkChars) {
			current = paragraph;
		} else {
			chunks.push(...splitOversizedParagraph(paragraph, maxChunkChars));
		}
	}

	if (current) {
		chunks.push(current);
	}

	return chunks;
}

/** Splits a single paragraph too large to fit in one chunk, breaking at sentence boundaries and falling back to a hard character cut for a single run-on sentence longer than the limit. */
function splitOversizedParagraph(paragraph: string, maxChunkChars: number): string[] {
	const sentences = paragraph.split(/([.!?]+\s+)/).reduce<string[]>((acc, part, index) => {
		if (index % 2 === 0) {
			acc.push(part);
		} else {
			acc[acc.length - 1] += part;
		}
		return acc;
	}, []).filter((sentence) => sentence.length > 0);
	const chunks: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		const withSentence = current ? `${current} ${sentence}` : sentence;
		if (withSentence.length <= maxChunkChars) {
			current = withSentence;
			continue;
		}

		if (current) {
			chunks.push(current);
			current = "";
		}

		if (sentence.length <= maxChunkChars) {
			current = sentence;
		} else {
			for (let i = 0; i < sentence.length; i += maxChunkChars) {
				chunks.push(sentence.slice(i, i + maxChunkChars));
			}
		}
	}

	if (current) {
		chunks.push(current);
	}

	return chunks;
}
