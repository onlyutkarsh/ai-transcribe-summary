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
}

export interface RecordingResult {
	blob: Blob;
	mimeType: string;
	durationMs: number;
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

	async start(options: AudioRecorderOptions): Promise<void> {
		const mimeType = pickSupportedMimeType();
		if (!mimeType) {
			throw new Error("This browser does not support any recordable audio format (MediaRecorder unavailable).");
		}

		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: options.microphoneDeviceId ? { deviceId: { exact: options.microphoneDeviceId } } : true,
		});

		this.mimeType = mimeType;
		this.chunks = [];
		this.recorder = new MediaRecorder(this.stream, {
			mimeType,
			audioBitsPerSecond: options.bitrateKbps * 1000,
		});
		this.recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) this.chunks.push(event.data);
		});

		this.startedAt = Date.now();
		this.recorder.start();
	}

	pause(): void {
		this.recorder?.pause();
	}

	resume(): void {
		this.recorder?.resume();
	}

	/** Stops the recorder and releases the mic. Resolves once the final chunk has been flushed. */
	async stop(): Promise<RecordingResult> {
		const recorder = this.recorder;
		if (!recorder) {
			throw new Error("AudioRecorder.stop() called without an active recording.");
		}

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
}
