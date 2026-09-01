import type { AudioBitrateKbps } from "../settings";

/** First supported mimeType wins - Opus is efficient at low bitrates (good fit for the 32kbps default). */
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];

export function pickSupportedMimeType(): string | undefined {
	if (typeof MediaRecorder === "undefined") return undefined;
	return CANDIDATE_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

/** Real frequency bands read off the analyser each animation frame, for the ribbon icon's per-bar visualizer. */
export const LEVEL_BAND_COUNT = 6;

export interface AudioRecorderOptions {
	microphoneDeviceId: string;
	bitrateKbps: AudioBitrateKbps;
	/** Minutes of continuous near-silence after which `onSilenceTimeout` fires. 0 disables silence detection. */
	silenceAutoStopMinutes: number;
	/** Called at most once per recording, from a polling interval, when `silenceAutoStopMinutes` of continuous near-silence is observed. Not called while paused. */
	onSilenceTimeout: () => void;
	/**
	 * Called on every animation frame with LEVEL_BAND_COUNT real frequency-band levels
	 * (0-1 each, low to high), for UI feedback - each band is independently normalized
	 * against its own recent peak (see startLevelMonitor), so bars fill visibly even for
	 * quiet-but-steady speech rather than needing to shout. Not called while paused.
	 */
	onLevel?: (bands: Float32Array) => void;
	/** Called at most once per recording if no input above the silence threshold is seen within DEAD_MIC_GRACE_MS of starting - a likely-broken capture device, surfaced early instead of only after transcription fails. Not called while paused (the grace window is measured in unpaused wall-clock time). */
	onDeadMic?: () => void;
}

export interface RecordingResult {
	blob: Blob;
	mimeType: string;
	durationMs: number;
}

const SILENCE_RMS_THRESHOLD = 0.01;
/** Silence auto-stop and dead-mic detection only need to sample every so often; ~10/s is plenty and keeps that accumulation logic on a wall-clock cadence independent of the animation frame rate. */
const SILENCE_POLL_INTERVAL_MS = 100;
/**
 * If no input above SILENCE_RMS_THRESHOLD is observed within this long after starting,
 * the mic is very likely not actually delivering audio (a stuck device/driver, rather than
 * the user just not having spoken yet) - warned via onDeadMic rather than left to surface
 * later as an opaque HTTP 400 from the transcription provider.
 */
const DEAD_MIC_GRACE_MS = 4000;

/**
 * Per-band ballistics for the ribbon visualizer, modeled on how a real level meter (and
 * Speech Kit's own ribbon, github.com/brittain9/speech-kit-obsidian-plugin) reacts: fast
 * attack so onsets snap into place immediately, much slower release so bars glide back down
 * instead of chattering with every tiny dip. Values are the fraction of the gap to the
 * target closed per animation frame (60fps assumed).
 */
const BAND_ATTACK = [0.95, 0.95, 0.95, 0.95, 0.99, 0.99];
const BAND_RELEASE = [0.06, 0.08, 0.07, 0.09, 0.1, 0.07];
/** Per-band running-peak decay per frame (~1s time constant at 60fps) - each band auto-normalizes against its own recent loudness, so quiet-but-steady speech still fills the bar instead of sitting near zero next to a fixed ceiling. */
const PEAK_DECAY_PER_FRAME = Math.exp(-1 / 60);
const PEAK_FLOOR = 0.02;

/**
 * Log-spaced speech band edges in Hz - matches Speech Kit's BAND_EDGES_HZ (its Rust sidecar,
 * native/src/audio_mixer.rs) exactly, so the same 6 bands used there (which the project's own
 * comments say restore "the independent per-bar motion the old client-side AnalyserNode tap
 * produced") are used here. Most speech energy sits below ~2kHz, so binning by raw FFT bin
 * index (linear in Hz) instead of these edges starves the upper bars of anything to show.
 */
const BAND_EDGES_HZ = [80, 200, 500, 1000, 2000, 4000, 8000];

/**
 * dB compander window applied per FFT bin before band averaging - also matches Speech Kit's
 * MIN_DB/MAX_DB exactly. This is what actually gives the bars visible swing: -60dB..-30dB is
 * a narrow 30dB window most speech falls inside, so companding into it (vs. a naive linear
 * magnitude average) is what makes normal talking volume swing bars across their full range
 * instead of barely nudging them.
 */
const MIN_DB = -60;
const MAX_DB = -30;

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

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
	private levelAnimationId: number | undefined;
	private silentMsAccumulated = 0;
	private unpausedMsSinceStart = 0;
	private deadMicChecked = false;
	private anySignalSeen = false;
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

			this.startLevelMonitor(stream, options);
		} catch (error) {
			// The recorder (and possibly a partially-constructed AudioContext, if the throw
			// came from startLevelMonitor) may already be running at this point - tear both
			// down before stopping the stream tracks, not just the stream, or they leak.
			try {
				this.recorder?.stop();
			} catch {
				// already stopped/inactive - ignore
			}
			this.stopLevelMonitor();
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

		this.stopLevelMonitor();

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
		this.stopLevelMonitor();
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

	/**
	 * Sets up a shared AnalyserNode on `stream` and starts two independent loops off it:
	 * a ~10/s interval for silence auto-stop + dead-mic detection (startSilencePoll), and a
	 * requestAnimationFrame loop feeding real per-band levels to options.onLevel for the
	 * ribbon visualizer (startLevelAnimation). Split so the visualizer's frame rate can't
	 * affect the wall-clock accuracy of silence-timeout accumulation, or vice versa.
	 */
	private startLevelMonitor(stream: MediaStream, options: AudioRecorderOptions): void {
		const audioContext = new AudioContext();
		// Assigned before the calls below that can throw, so a caller-side catch can close
		// this context via stopLevelMonitor() even if setup fails partway through.
		this.audioContext = audioContext;

		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		source.connect(analyser);
		this.analyser = analyser;

		this.startSilencePoll(analyser, options);
		if (options.onLevel) this.startLevelAnimation(audioContext, analyser, options.onLevel);
	}

	/** Drives dead-mic detection and, if configured, silence auto-stop - both measured in wall-clock ms, independent of the visualizer's animation-frame cadence. */
	private startSilencePoll(analyser: AnalyserNode, options: AudioRecorderOptions): void {
		this.silentMsAccumulated = 0;
		this.unpausedMsSinceStart = 0;
		this.deadMicChecked = false;
		this.anySignalSeen = false;

		const silenceThresholdMs = options.silenceAutoStopMinutes * 60 * 1000;
		const data = new Float32Array(analyser.fftSize);

		this.silencePollId = window.setInterval(() => {
			if (this.paused) return;

			analyser.getFloatTimeDomainData(data);
			let sumSquares = 0;
			for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
			const rms = Math.sqrt(sumSquares / data.length);

			if (rms >= SILENCE_RMS_THRESHOLD) this.anySignalSeen = true;
			this.unpausedMsSinceStart += SILENCE_POLL_INTERVAL_MS;
			if (!this.deadMicChecked && this.unpausedMsSinceStart >= DEAD_MIC_GRACE_MS) {
				this.deadMicChecked = true;
				if (!this.anySignalSeen) options.onDeadMic?.();
			}

			if (silenceThresholdMs > 0) {
				if (rms < SILENCE_RMS_THRESHOLD) {
					this.silentMsAccumulated += SILENCE_POLL_INTERVAL_MS;
					if (this.silentMsAccumulated >= silenceThresholdMs) {
						this.stopLevelMonitor();
						options.onSilenceTimeout();
					}
				} else {
					this.silentMsAccumulated = 0;
				}
			}
		}, SILENCE_POLL_INTERVAL_MS);
	}

	/**
	 * Reads real per-band frequency energy every animation frame (~60fps), dB-compands each
	 * bin into [0, 1] (matching Speech Kit's MIN_DB/MAX_DB window exactly - see BAND_EDGES_HZ's
	 * comment), then applies fast-attack/slow-release ballistics plus per-band peak auto-gain.
	 * Real spectral content dB-companded this way is what makes the bars swing visibly and look
	 * independent, not a linear magnitude average (which barely moves for normal speech) or
	 * synthetic per-bar smoothing over one aggregate number.
	 */
	private startLevelAnimation(audioContext: AudioContext, analyser: AnalyserNode, onLevel: (bands: Float32Array) => void): void {
		// getFloatFrequencyData returns dB directly (vs. the byte variant's internal 0-255
		// rescale to [minDecibels, maxDecibels]) - widen those so the node doesn't clip values
		// before our own MIN_DB/MAX_DB companding gets to see them. smoothingTimeConstant
		// defaults to 0.8 - the node would otherwise pre-smooth every reading before our own
		// attack/release ballistics run, doubling up damping and flattening the bars.
		analyser.minDecibels = -100;
		analyser.maxDecibels = 0;
		analyser.smoothingTimeConstant = 0;

		const freqData = new Float32Array(analyser.frequencyBinCount);
		const smoothed = new Float32Array(LEVEL_BAND_COUNT);
		const peaks = new Float32Array(LEVEL_BAND_COUNT).fill(PEAK_FLOOR);

		const hzPerBin = audioContext.sampleRate / analyser.fftSize;
		const bandBins: Array<[number, number]> = [];
		for (let band = 0; band < LEVEL_BAND_COUNT; band++) {
			const lo = Math.max(1, Math.floor(BAND_EDGES_HZ[band] / hzPerBin));
			const hi = Math.min(freqData.length, Math.max(lo + 1, Math.floor(BAND_EDGES_HZ[band + 1] / hzPerBin)));
			bandBins.push([lo, hi]);
		}

		const tick = () => {
			if (this.paused) {
				this.levelAnimationId = window.requestAnimationFrame(tick);
				return;
			}

			analyser.getFloatFrequencyData(freqData);

			for (let band = 0; band < LEVEL_BAND_COUNT; band++) {
				const [lo, hi] = bandBins[band];
				let sum = 0;
				for (let bin = lo; bin < hi; bin++) {
					const decibels = freqData[bin];
					sum += clamp01((decibels - MIN_DB) / (MAX_DB - MIN_DB));
				}
				const raw = sum / (hi - lo);

				const peak = Math.max(raw, peaks[band] * PEAK_DECAY_PER_FRAME, PEAK_FLOOR);
				peaks[band] = peak;
				const normalized = Math.min(1, raw / peak);

				const previous = smoothed[band];
				const coefficient = normalized > previous ? BAND_ATTACK[band] : BAND_RELEASE[band];
				smoothed[band] = previous + (normalized - previous) * coefficient;
			}

			onLevel(smoothed);
			this.levelAnimationId = window.requestAnimationFrame(tick);
		};

		this.levelAnimationId = window.requestAnimationFrame(tick);
	}

	private stopLevelMonitor(): void {
		if (this.silencePollId !== undefined) {
			window.clearInterval(this.silencePollId);
			this.silencePollId = undefined;
		}
		if (this.levelAnimationId !== undefined) {
			window.cancelAnimationFrame(this.levelAnimationId);
			this.levelAnimationId = undefined;
		}
		this.analyser = undefined;
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = undefined;
		}
	}
}
