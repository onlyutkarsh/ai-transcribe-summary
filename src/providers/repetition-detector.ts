/**
 * Whisper occasionally gets stuck repeating a word/phrase on silent or
 * low-signal audio (PRD Tier 1). Flags it so the caller can prepend a
 * warning rather than silently trusting a corrupted transcript.
 */
const MIN_PHRASE_WORDS = 1;
const MAX_PHRASE_WORDS = 6;
const REPEAT_THRESHOLD = 8;

export function hasRepetitionLoop(text: string): boolean {
	const words = text
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word.length > 0);

	for (let phraseLen = MIN_PHRASE_WORDS; phraseLen <= MAX_PHRASE_WORDS; phraseLen++) {
		let runLength = 1;
		for (let i = phraseLen; i + phraseLen <= words.length; i += phraseLen) {
			const current = words.slice(i, i + phraseLen).join(" ");
			const previous = words.slice(i - phraseLen, i).join(" ");
			if (current === previous) {
				runLength++;
				if (runLength >= REPEAT_THRESHOLD) return true;
			} else {
				runLength = 1;
			}
		}
	}

	return false;
}
