/**
 * Splits an oversized recording into pieces at natural silence gaps, so a
 * >22MB Whisper upload doesn't hit the 25MB hard ceiling (PRD Tier 1).
 * Decodes to PCM once, finds low-RMS gaps, and re-encodes each piece as WAV
 * (Whisper accepts WAV directly - simpler and lossless vs. re-encoding to
 * webm/opus, and this only runs on the rare oversized recording).
 */
const WHISPER_CHUNK_THRESHOLD_BYTES = 22 * 1024 * 1024;
const SILENCE_RMS_THRESHOLD = 0.01;
const MIN_SILENCE_GAP_SECONDS = 0.5;
const ANALYSIS_WINDOW_SECONDS = 0.05;

export interface AudioChunk {
	data: ArrayBuffer;
	mimeType: string;
}

export function needsChunking(blob: Blob): boolean {
	return blob.size > WHISPER_CHUNK_THRESHOLD_BYTES;
}

export async function chunkAtSilence(blob: Blob, targetChunkBytes = WHISPER_CHUNK_THRESHOLD_BYTES): Promise<AudioChunk[]> {
	const audioContext = new AudioContext();
	let buffer: AudioBuffer;
	try {
		buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
	} finally {
		await audioContext.close();
	}

	const splitPoints = findSilenceSplitPoints(buffer, targetChunkBytes);
	const chunks: AudioChunk[] = [];
	let startSample = 0;

	for (const splitSample of [...splitPoints, buffer.length]) {
		chunks.push({ data: encodeWav(buffer, startSample, splitSample), mimeType: "audio/wav" });
		startSample = splitSample;
	}

	return chunks;
}

/** Picks silence-gap sample indices roughly every `targetChunkBytes` (measured in equivalent WAV size) worth of audio. */
function findSilenceSplitPoints(buffer: AudioBuffer, targetChunkBytes: number): number[] {
	const bytesPerSample = 2 * buffer.numberOfChannels;
	const targetChunkSamples = Math.floor(targetChunkBytes / bytesPerSample);
	const windowSamples = Math.max(1, Math.floor(ANALYSIS_WINDOW_SECONDS * buffer.sampleRate));
	const minGapSamples = Math.max(1, Math.floor(MIN_SILENCE_GAP_SECONDS * buffer.sampleRate));

	const channelData = buffer.getChannelData(0);
	const splitPoints: number[] = [];
	let nextTarget = targetChunkSamples;

	while (nextTarget < buffer.length) {
		const gapCenter = findNearestSilenceCenter(channelData, nextTarget, windowSamples, minGapSamples);
		const splitAt = gapCenter ?? nextTarget;
		splitPoints.push(splitAt);
		nextTarget = splitAt + targetChunkSamples;
	}

	return splitPoints;
}

/** Searches outward from `around` for a run of low-RMS windows at least `minGapSamples` long; returns its midpoint, or undefined if none found nearby. */
function findNearestSilenceCenter(channelData: Float32Array, around: number, windowSamples: number, minGapSamples: number): number | undefined {
	const searchRadius = minGapSamples * 20;
	const searchStart = Math.max(0, around - searchRadius);
	const searchEnd = Math.min(channelData.length, around + searchRadius);

	let runStart: number | undefined;
	let bestCenter: number | undefined;
	let bestDistance = Infinity;

	for (let i = searchStart; i < searchEnd; i += windowSamples) {
		const windowEnd = Math.min(i + windowSamples, channelData.length);
		const isSilent = rms(channelData, i, windowEnd) < SILENCE_RMS_THRESHOLD;

		if (isSilent) {
			if (runStart === undefined) runStart = i;
		} else if (runStart !== undefined) {
			if (i - runStart >= minGapSamples) {
				const center = Math.floor((runStart + i) / 2);
				const distance = Math.abs(center - around);
				if (distance < bestDistance) {
					bestDistance = distance;
					bestCenter = center;
				}
			}
			runStart = undefined;
		}
	}

	return bestCenter;
}

function rms(channelData: Float32Array, start: number, end: number): number {
	let sumSquares = 0;
	for (let i = start; i < end; i++) {
		sumSquares += channelData[i] * channelData[i];
	}
	return Math.sqrt(sumSquares / Math.max(1, end - start));
}

/** Encodes samples [startSample, endSample) of `buffer` as a 16-bit PCM WAV file. */
function encodeWav(buffer: AudioBuffer, startSample: number, endSample: number): ArrayBuffer {
	const numChannels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const numFrames = endSample - startSample;
	const bytesPerSample = 2;
	const blockAlign = numChannels * bytesPerSample;
	const dataSize = numFrames * blockAlign;

	const arrayBuffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(arrayBuffer);

	writeString(view, 0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeString(view, 8, "WAVE");
	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bytesPerSample * 8, true);
	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	const channels: Float32Array[] = [];
	for (let ch = 0; ch < numChannels; ch++) {
		channels.push(buffer.getChannelData(ch));
	}

	let offset = 44;
	for (let i = startSample; i < endSample; i++) {
		for (let ch = 0; ch < numChannels; ch++) {
			const sample = Math.max(-1, Math.min(1, channels[ch][i]));
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			offset += 2;
		}
	}

	return arrayBuffer;
}

function writeString(view: DataView, offset: number, value: string): void {
	for (let i = 0; i < value.length; i++) {
		view.setUint8(offset + i, value.charCodeAt(i));
	}
}
