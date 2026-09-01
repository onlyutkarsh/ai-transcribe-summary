import type { AudioBitrateKbps } from "../settings";

/** First supported mimeType wins - Opus is efficient at low bitrates (good fit for the 32kbps default). */
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];

export function pickSupportedMimeType(): string | undefined {
	if (typeof MediaRecorder === "undefined") return undefined;
	return CANDIDATE_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

export interface AudioRecorderOptions {
	microphoneDeviceId: string;
	bitrateKbps: AudioBitrateKbps;
	/** Minutes of continuous near-silence after which `onSilenceTimeout` fires. 0 disables silence detection. */
	silenceAutoStopMinutes: number;
	/** Called at most once per recording, from a polling interval, when `silenceAutoStopMinutes` of continuous near-silence is observed. Not called while paused. */
	onSilenceTimeout: () => void;
}

export interface RecordingResult {
	blob: Blob;
	mimeType: string;
	durationMs: number;
}

const SILENCE_RMS_THRESHOLD = 0.01;
const SILENCE_POLL_INTERVAL_MS = 1000;

/** Decodes `blob` and checks whether its overall RMS level is at/below the same threshold the in-recording silence monitor uses, i.e. whether the whole clip is effectively silent rather than just quiet. */
export async function isRecordingSilent(blob: Blob): Promise<boolean> {
	const audioContext = new AudioContext();
	let buffer: AudioBuffer;
	try {
		buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
	} finally {
		await audioContext.close();
	}

	let sumSquares = 0;
	let sampleCount = 0;
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
		sampleCount += data.length;
	}

	const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
	return rms < SILENCE_RMS_THRESHOLD;
}

/**
 * Thin wrapper around getUserMedia + MediaRecorder. Owns the media stream and
 * recorder instance for a single record/pause/resume/stop lifecycle; callers
 * (main.ts) own recording *state* (idle/recording/paused) and timing display.
 */
export class AudioRecorder {
	private stream: MediaStream | undefined;
	private recorder: MediaRecorder | undefined;
	private chunks: Blob[] = [];
	private mimeType = "";
	private startedAt = 0;

	private audioContext: AudioContext | undefined;
	private analyser: AnalyserNode | undefined;
	private silencePollId: number | undefined;
	private silentMsAccumulated = 0;
	private paused = false;

	async start(options: AudioRecorderOptions): Promise<void> {
		const mimeType = pickSupportedMimeType();
		if (!mimeType) {
			throw new Error("This browser does not support any recordable audio format (MediaRecorder unavailable).");
		}

		const stream = await navigator.mediaDevices.getUserMedia({
			audio: options.microphoneDeviceId ? { deviceId: { exact: options.microphoneDeviceId } } : true,
		});

		try {
			this.mimeType = mimeType;
			this.chunks = [];
			this.recorder = new MediaRecorder(stream, {
				mimeType,
				audioBitsPerSecond: options.bitrateKbps * 1000,
			});
			this.recorder.addEventListener("dataavailable", (event) => {
				if (event.data.size > 0) this.chunks.push(event.data);
			});

			this.startedAt = Date.now();
			this.paused = false;
			this.recorder.start();

			if (options.silenceAutoStopMinutes > 0) {
				this.startSilenceMonitor(stream, options.silenceAutoStopMinutes, options.onSilenceTimeout);
			}
		} catch (error) {
			// The recorder (and possibly a partially-constructed AudioContext, if the throw
			// came from startSilenceMonitor) may already be running at this point - tear both
			// down before stopping the stream tracks, not just the stream, or they leak.
			try {
				this.recorder?.stop();
			} catch {
				// already stopped/inactive - ignore
			}
			this.stopSilenceMonitor();
			stream.getTracks().forEach((track) => track.stop());
			this.recorder = undefined;
			throw error;
		}

		this.stream = stream;
	}

	pause(): void {
		this.recorder?.pause();
		this.paused = true;
	}

	resume(): void {
		this.recorder?.resume();
		this.paused = false;
		this.silentMsAccumulated = 0;
	}

	/** Stops the recorder and releases the mic. Resolves once the final chunk has been flushed. */
	async stop(): Promise<RecordingResult> {
		const recorder = this.recorder;
		if (!recorder) {
			throw new Error("AudioRecorder.stop() called without an active recording.");
		}

		this.stopSilenceMonitor();

		await new Promise<void>((resolve) => {
			recorder.addEventListener("stop", () => resolve(), { once: true });
			recorder.stop();
		});

		this.stream?.getTracks().forEach((track) => track.stop());

		const result: RecordingResult = {
			blob: new Blob(this.chunks, { type: this.mimeType }),
			mimeType: this.mimeType,
			durationMs: Date.now() - this.startedAt,
		};

		this.stream = undefined;
		this.recorder = undefined;
		this.chunks = [];

		return result;
	}

	/** Best-effort teardown for e.g. plugin unload mid-recording; discards audio rather than saving it. */
	discard(): void {
		this.stopSilenceMonitor();
		try {
			this.recorder?.stop();
		} catch {
			// already stopped/inactive - ignore
		}
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = undefined;
		this.recorder = undefined;
		this.chunks = [];
	}

	/** Polls RMS level on `stream` every second; fires `onTimeout` once continuous near-silence exceeds `minutes`. */
	private startSilenceMonitor(stream: MediaStream, minutes: number, onTimeout: () => void): void {
		const audioContext = new AudioContext();
		// Assigned before the calls below that can throw, so a caller-side catch can close
		// this context via stopSilenceMonitor() even if setup fails partway through.
		this.audioContext = audioContext;

		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		source.connect(analyser);

		this.analyser = analyser;
		this.silentMsAccumulated = 0;

		const thresholdMs = minutes * 60 * 1000;
		const data = new Float32Array(analyser.fftSize);

		this.silencePollId = window.setInterval(() => {
			if (this.paused) return;

			analyser.getFloatTimeDomainData(data);
			let sumSquares = 0;
			for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
			const rms = Math.sqrt(sumSquares / data.length);

			if (rms < SILENCE_RMS_THRESHOLD) {
				this.silentMsAccumulated += SILENCE_POLL_INTERVAL_MS;
				if (this.silentMsAccumulated >= thresholdMs) {
					this.stopSilenceMonitor();
					onTimeout();
				}
			} else {
				this.silentMsAccumulated = 0;
			}
		}, SILENCE_POLL_INTERVAL_MS);
	}

	private stopSilenceMonitor(): void {
		if (this.silencePollId !== undefined) {
			window.clearInterval(this.silencePollId);
			this.silencePollId = undefined;
		}
		this.analyser = undefined;
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = undefined;
		}
	}
}
