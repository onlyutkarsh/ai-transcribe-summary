import { App, Menu, Modal, normalizePath, Notice, Plugin, Setting, TAbstractFile, TFile, TFolder } from "obsidian";
import { AudioRecorder, RecordingResult } from "./audio/recorder";
import { formatTimestampForFilename, isAudioFile, runTranscribeAndSummarizePipeline } from "./pipeline";
import { AiTranscribeSummarySettingTab, AiTranscribeSummarySettings, DEFAULT_SETTINGS } from "./settings";

/** audio/webm -> webm, audio/ogg;codecs=opus -> ogg, etc. */
function extensionForMimeType(mimeType: string): string {
	const subtype = mimeType.split(";")[0].split("/")[1];
	return subtype || "webm";
}

/** Single-character spinner frames - fixed width, so the status bar item doesn't resize/jitter as it animates (unlike a growing "..." suffix). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const EXTENSION_MIME_TYPES: Record<string, string> = {
	webm: "audio/webm",
	ogg: "audio/ogg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
};

function mimeTypeForExtension(extension: string): string {
	return EXTENSION_MIME_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Above this duration, splitting an oversized recording (chunker.ts's
 * chunkAtSilence) decodes to a large enough in-memory PCM buffer that it
 * risks exhausting tab memory on constrained machines - warn before it
 * happens rather than let the decode fail unpredictably. Based on duration
 * alone (not file size, which varies with the configured bitrate) since
 * that's what drives decoded PCM size; assumes a worst-case stereo/48kHz
 * source (~2GB at 3hrs) since MediaRecorder doesn't expose the actual
 * sample rate/channel count picked by the browser/OS.
 */
const LONG_RECORDING_WARNING_MS = 3 * 60 * 60 * 1000;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

type RecordingState = "idle" | "recording" | "paused";

class StopRecordingConfirmModal extends Modal {
	private confirmed = false;

	constructor(app: App, private onConfirm: () => void, private onCancel: () => void) {
		super(app);
	}

	onOpen() {
		this.setTitle("Stop recording?");
		this.contentEl.createEl("p", { text: "This will end the current recording. This can't be undone." });

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Stop recording")
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel();
	}
}

export default class AiTranscribeSummaryPlugin extends Plugin {
	declare settings: AiTranscribeSummarySettings;

	private statusBarItem!: HTMLElement;
	private state: RecordingState = "idle";
	/** True while start/stop is in flight (awaiting mic permission or recorder.stop()'s final chunk) - blocks re-entrant start/stop so a quick second action can't race the recorder's stream/chunks out from under the in-flight one. */
	private transitioning = false;
	/** Set once onunload() runs, so a startRecording() whose getUserMedia() was still pending at unload time can detect teardown and discard the now-unmanaged stream instead of continuing as if the plugin were still active. */
	private unloaded = false;
	private segmentStartedAt = 0;
	private accumulatedMs = 0;
	private timerIntervalId: number | undefined;
	private ribbonIconEl!: HTMLElement;
	private recorder = new AudioRecorder();

	/** One entry per in-flight pipeline job (a right-click "Transcribe & summarize", or the post-recording pipeline), keyed by a locally-unique id - so one job finishing doesn't stop/hide the shared status bar spinner while others are still running. */
	private activePipelineJobs = new Map<number, string>();
	private nextPipelineJobId = 0;
	private pipelineAnimationIntervalId: number | undefined;
	private pipelineAnimationFrame = 0;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.hide();

		this.ribbonIconEl = this.addRibbonIcon("mic", "Start meeting recording", () => {
			if (this.transitioning) return;
			if (this.state === "idle") {
				void this.startRecording();
			} else {
				this.requestStopRecording();
			}
		});

		this.addCommand({
			id: "start-recording",
			name: "Start recording",
			checkCallback: (checking) => {
				if (this.state !== "idle" || this.transitioning) return false;
				if (!checking) void this.startRecording();
				return true;
			},
		});

		this.addCommand({
			id: "stop-recording",
			name: "Stop recording",
			checkCallback: (checking) => {
				if (this.state === "idle" || this.transitioning) return false;
				if (!checking) this.requestStopRecording();
				return true;
			},
		});

		this.addCommand({
			id: "toggle-pause-recording",
			name: "Pause/resume recording",
			checkCallback: (checking) => {
				if (this.state === "idle" || this.transitioning) return false;
				if (!checking) this.togglePause();
				return true;
			},
		});

		this.addCommand({
			id: "transcribe-and-summarize-active-file",
			name: "Transcribe & summarize active file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isAudioFile(file)) return false;
				if (!checking) void this.transcribeAndSummarizeFile(file);
				return true;
			},
		});

		this.addSettingTab(new AiTranscribeSummarySettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)));
	}

	private onFileMenu(menu: Menu, file: TAbstractFile) {
		if (!(file instanceof TFile) || !isAudioFile(file)) return;

		menu.addItem((item) =>
			item
				.setTitle("Transcribe & summarize")
				.setIcon("captions")
				.onClick(() => void this.transcribeAndSummarizeFile(file))
		);
	}

	private async transcribeAndSummarizeFile(file: TFile): Promise<void> {
		const jobId = this.beginPipelineJob();
		try {
			const blob = new Blob([await this.app.vault.readBinary(file)], { type: mimeTypeForExtension(file.extension) });
			await runTranscribeAndSummarizePipeline(
				this.app,
				this.settings,
				{ blob, mimeType: blob.type, baseName: file.basename, audioFile: file },
				{ insertIntoActiveNote: false, onProgress: (status) => this.showPipelineProgress(jobId, status) }
			);
		} catch (error) {
			console.error("ai-transcribe-summary: transcribe & summarize failed", error);
			new Notice(`Transcribe & summarize failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.endPipelineJob(jobId);
		}
	}

	/** Registers a new pipeline job and returns its id, to be passed to showPipelineProgress/endPipelineJob for the lifetime of that job. */
	private beginPipelineJob(): number {
		return this.nextPipelineJobId++;
	}

	private showPipelineProgress(jobId: number, status: string) {
		this.activePipelineJobs.set(jobId, status);
		this.statusBarItem.show();
		this.renderPipelineProgress();

		if (this.pipelineAnimationIntervalId === undefined) {
			this.pipelineAnimationIntervalId = window.setInterval(() => this.renderPipelineProgress(), 100);
			this.registerInterval(this.pipelineAnimationIntervalId);
		}
	}

	private renderPipelineProgress() {
		const frame = SPINNER_FRAMES[this.pipelineAnimationFrame];
		this.pipelineAnimationFrame = (this.pipelineAnimationFrame + 1) % SPINNER_FRAMES.length;

		// Map iteration order is insertion order, so this is the most recently *started* job,
		// not necessarily the most recently updated one - a reasonable stand-in given the
		// status bar can only show one line, and job status changes are infrequent.
		const statuses = [...this.activePipelineJobs.values()];
		const mostRecent = statuses[statuses.length - 1];
		const otherCount = statuses.length - 1;
		const suffix = otherCount > 0 ? ` (+${otherCount} more)` : "";
		this.statusBarItem.setText(`${frame} ${mostRecent}${suffix}`);
	}

	/** Ends one pipeline job. Only stops the shared spinner/hides the status bar once no other job is still active. */
	private endPipelineJob(jobId: number) {
		this.activePipelineJobs.delete(jobId);
		if (this.activePipelineJobs.size > 0) {
			this.renderPipelineProgress();
			return;
		}

		if (this.pipelineAnimationIntervalId !== undefined) {
			window.clearInterval(this.pipelineAnimationIntervalId);
			this.pipelineAnimationIntervalId = undefined;
		}
		if (this.state === "idle") {
			this.statusBarItem.hide();
		} else {
			// A recording is still in progress - restore its display immediately instead of
			// leaving the last spinner frame on screen until the next 1s timer tick.
			this.updateStatusBar();
		}
	}

	onunload() {
		this.unloaded = true;
		this.stopTimer();
		if (this.state !== "idle") {
			this.recorder.discard();
		}
	}

	private requestStopRecording() {
		if (this.settings.confirmBeforeStoppingRecording) {
			// Reserve the transition immediately so a second stop action can't open another
			// confirm modal while this one is still open - only one stopRecording() may run
			// against the recorder at a time. Released if the user cancels.
			this.transitioning = true;
			new StopRecordingConfirmModal(
				this.app,
				() => void this.stopRecording(),
				() => {
					this.transitioning = false;
				}
			).open();
		} else {
			void this.stopRecording();
		}
	}

	private togglePause() {
		if (this.state === "recording") {
			this.pauseRecording();
		} else if (this.state === "paused") {
			this.resumeRecording();
		}
	}

	private async startRecording() {
		this.transitioning = true;
		try {
			await this.recorder.start({
				microphoneDeviceId: this.settings.microphoneDeviceId,
				bitrateKbps: this.settings.audioBitrateKbps,
				silenceAutoStopMinutes: this.settings.silenceAutoStopMinutes,
				onSilenceTimeout: () => this.autoStopRecording(`${this.settings.silenceAutoStopMinutes} minutes of silence`),
			});
		} catch (error) {
			console.error("ai-transcribe-summary: failed to start recording", error);
			new Notice("Could not start recording - check microphone permissions.");
			return;
		} finally {
			this.transitioning = false;
		}

		if (this.unloaded) {
			// Plugin was disabled/reloaded while getUserMedia() was still pending - the mic
			// stream this just acquired is unmanaged by anything still running, so tear it
			// down immediately instead of continuing to "record" past teardown.
			this.recorder.discard();
			return;
		}

		this.state = "recording";
		this.accumulatedMs = 0;
		this.segmentStartedAt = Date.now();

		this.ribbonIconEl.addClass("is-active");
		this.ribbonIconEl.setAttribute("aria-label", "Stop meeting recording");

		this.statusBarItem.show();
		this.updateStatusBar();
		this.startTimer();
	}

	private pauseRecording() {
		this.recorder.pause();
		this.accumulatedMs += Date.now() - this.segmentStartedAt;
		this.state = "paused";
		this.stopTimer();
		this.updateStatusBar();
	}

	private resumeRecording() {
		this.recorder.resume();
		this.segmentStartedAt = Date.now();
		this.state = "recording";
		this.updateStatusBar();
		this.startTimer();
	}

	private async stopRecording() {
		this.transitioning = true;
		this.stopTimer();

		let result: RecordingResult;
		try {
			result = await this.recorder.stop();
		} catch (error) {
			console.error("ai-transcribe-summary: failed to stop recording", error);
			new Notice("Recording stop failed - no audio was saved.");
			this.state = "idle";
			this.transitioning = false;
			this.ribbonIconEl.removeClass("is-active");
			this.ribbonIconEl.setAttribute("aria-label", "Start meeting recording");
			this.statusBarItem.hide();
			return;
		}

		this.state = "idle";
		this.transitioning = false;
		this.ribbonIconEl.removeClass("is-active");
		this.ribbonIconEl.setAttribute("aria-label", "Start meeting recording");

		// Raw audio is always preserved regardless of what transcription/summary do downstream.
		let savedFile: TFile | undefined;
		if (this.settings.saveAudioFile) {
			savedFile = await this.saveRecording(result);
		}

		if (result.durationMs > LONG_RECORDING_WARNING_MS) {
			new Notice(
				`This recording is over ${Math.round(LONG_RECORDING_WARNING_MS / (60 * 60 * 1000))} hours long. If it needs to be split for transcription, decoding it may use a lot of memory and could fail on this device.${
					savedFile ? " The audio file is already saved, so it's safe either way." : ""
				}`,
				10000
			);
		}

		const jobId = this.beginPipelineJob();
		try {
			await runTranscribeAndSummarizePipeline(
				this.app,
				this.settings,
				{ blob: result.blob, mimeType: result.mimeType, baseName: savedFile?.basename ?? `meeting ${formatTimestampForFilename(new Date())}`, audioFile: savedFile },
				{ insertIntoActiveNote: true, onProgress: (status) => this.showPipelineProgress(jobId, status) }
			);
		} catch (error) {
			console.error("ai-transcribe-summary: transcribe & summarize failed", error);
			new Notice(`Transcribe & summarize failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.endPipelineJob(jobId);
		}
	}

	private async saveRecording(result: RecordingResult): Promise<TFile | undefined> {
		const folderPath = normalizePath(this.settings.audioFolder);

		try {
			const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!existingFolder) {
				await this.app.vault.createFolder(folderPath);
			} else if (!(existingFolder instanceof TFolder)) {
				new Notice(`Audio folder "${folderPath}" is not a folder - recording not saved.`);
				return undefined;
			}
		} catch (error) {
			console.error("ai-transcribe-summary: failed to create audio folder", error);
			new Notice("Failed to create audio folder - recording not saved. See console for details.");
			return undefined;
		}

		const extension = extensionForMimeType(result.mimeType);
		const filePath = normalizePath(`${folderPath}/meeting ${formatTimestampForFilename(new Date())}.${extension}`);

		try {
			const arrayBuffer = await result.blob.arrayBuffer();
			const file = await this.app.vault.createBinary(filePath, arrayBuffer);
			new Notice(`Recording saved to ${filePath}`);
			return file;
		} catch (error) {
			console.error("ai-transcribe-summary: failed to save recording", error);
			new Notice("Failed to save recording audio file - see console for details.");
			return undefined;
		}
	}

	private startTimer() {
		this.timerIntervalId = window.setInterval(() => this.updateStatusBar(), 1000);
		this.registerInterval(this.timerIntervalId);
	}

	private stopTimer() {
		if (this.timerIntervalId !== undefined) {
			window.clearInterval(this.timerIntervalId);
			this.timerIntervalId = undefined;
		}
	}

	private updateStatusBar() {
		const elapsed = this.accumulatedMs + (this.state === "recording" ? Date.now() - this.segmentStartedAt : 0);

		// While a pipeline job is showing its spinner, let it own the status bar text - otherwise
		// this 1s timer tick and the 100ms spinner tick fight over the same line. The max-duration
		// check below still runs regardless, so a long recording auto-stops even mid-pipeline-job.
		if (this.activePipelineJobs.size === 0) {
			const icon = this.state === "paused" ? "⏸" : "🔴";
			const label = this.state === "paused" ? "Paused" : "Recording";
			this.statusBarItem.setText(`${icon} ${label} ${formatElapsed(elapsed)}`);
		}

		const maxMs = this.settings.maxRecordingHours * 60 * 60 * 1000;
		if (this.state === "recording" && maxMs > 0 && elapsed >= maxMs) {
			this.autoStopRecording(`the ${this.settings.maxRecordingHours}-hour maximum recording duration`);
		}
	}

	/** Stops the recording without the usual confirm-before-stopping prompt, since the user isn't the one initiating it. */
	private autoStopRecording(reason: string) {
		if (this.state === "idle" || this.transitioning) return;
		new Notice(`Recording auto-stopped: reached ${reason}.`);
		void this.stopRecording();
	}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Partial<AiTranscribeSummarySettings>;

		// Object.assign only merges top-level keys - a saved settings file from
		// before a field was added to a nested per-provider object (e.g.
		// temperature) would otherwise replace that whole object wholesale and
		// leave the new field undefined, instead of falling back to its default.
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			providers: {
				openai: { ...DEFAULT_SETTINGS.providers.openai, ...saved.providers?.openai },
				openrouter: { ...DEFAULT_SETTINGS.providers.openrouter, ...saved.providers?.openrouter },
			},
			summaryProviders: {
				openai: { ...DEFAULT_SETTINGS.summaryProviders.openai, ...saved.summaryProviders?.openai },
				openrouter: { ...DEFAULT_SETTINGS.summaryProviders.openrouter, ...saved.summaryProviders?.openrouter },
			},
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
