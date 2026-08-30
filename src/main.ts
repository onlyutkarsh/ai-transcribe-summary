import { App, Menu, Modal, normalizePath, Notice, Plugin, Setting, TAbstractFile, TFile, TFolder } from "obsidian";
import { AudioRecorder, RecordingResult } from "./audio/recorder";
import { isAudioFile, runTranscribeAndSummarizePipeline } from "./pipeline";
import { AiTranscribeSummarySettingTab, AiTranscribeSummarySettings, DEFAULT_SETTINGS } from "./settings";

/** audio/webm -> webm, audio/ogg;codecs=opus -> ogg, etc. */
function extensionForMimeType(mimeType: string): string {
	const subtype = mimeType.split(";")[0].split("/")[1];
	return subtype || "webm";
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
	webm: "audio/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
};

function mimeTypeForExtension(extension: string): string {
	return EXTENSION_MIME_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}

function formatTimestampForFilename(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

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
	constructor(app: App, private onConfirm: () => void) {
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
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export default class AiTranscribeSummaryPlugin extends Plugin {
	declare settings: AiTranscribeSummarySettings;

	private statusBarItem!: HTMLElement;
	private state: RecordingState = "idle";
	private segmentStartedAt = 0;
	private accumulatedMs = 0;
	private timerIntervalId: number | undefined;
	private ribbonIconEl!: HTMLElement;
	private recorder = new AudioRecorder();

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.hide();

		this.ribbonIconEl = this.addRibbonIcon("mic", "Start meeting recording", () => {
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
				if (this.state !== "idle") return false;
				if (!checking) void this.startRecording();
				return true;
			},
		});

		this.addCommand({
			id: "stop-recording",
			name: "Stop recording",
			checkCallback: (checking) => {
				if (this.state === "idle") return false;
				if (!checking) this.requestStopRecording();
				return true;
			},
		});

		this.addCommand({
			id: "toggle-pause-recording",
			name: "Pause/resume recording",
			checkCallback: (checking) => {
				if (this.state === "idle") return false;
				if (!checking) this.togglePause();
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
		try {
			const blob = new Blob([await this.app.vault.readBinary(file)], { type: mimeTypeForExtension(file.extension) });
			await runTranscribeAndSummarizePipeline(
				this.app,
				this.settings,
				{ blob, mimeType: blob.type, baseName: file.basename },
				{ insertIntoActiveNote: false, onProgress: (status) => this.showPipelineProgress(status) }
			);
		} catch (error) {
			console.error("ai-transcribe-summary: transcribe & summarize failed", error);
			new Notice(`Transcribe & summarize failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.hidePipelineProgress();
		}
	}

	private showPipelineProgress(status: string) {
		this.statusBarItem.setText(status);
		this.statusBarItem.show();
	}

	private hidePipelineProgress() {
		if (this.state === "idle") {
			this.statusBarItem.hide();
		}
	}

	onunload() {
		this.stopTimer();
		if (this.state !== "idle") {
			this.recorder.discard();
		}
	}

	private requestStopRecording() {
		if (this.settings.confirmBeforeStoppingRecording) {
			new StopRecordingConfirmModal(this.app, () => void this.stopRecording()).open();
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
		try {
			await this.recorder.start({
				microphoneDeviceId: this.settings.microphoneDeviceId,
				bitrateKbps: this.settings.audioBitrateKbps,
			});
		} catch (error) {
			console.error("ai-transcribe-summary: failed to start recording", error);
			new Notice("Could not start recording - check microphone permissions.");
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
		this.state = "idle";
		this.stopTimer();

		this.ribbonIconEl.removeClass("is-active");
		this.ribbonIconEl.setAttribute("aria-label", "Start meeting recording");

		let result: RecordingResult;
		try {
			result = await this.recorder.stop();
		} catch (error) {
			console.error("ai-transcribe-summary: failed to stop recording", error);
			new Notice("Recording stop failed - no audio was saved.");
			this.statusBarItem.hide();
			return;
		}

		// Raw audio is always preserved regardless of what transcription/summary do downstream.
		let savedFile: TFile | undefined;
		if (this.settings.saveAudioFile) {
			savedFile = await this.saveRecording(result);
		}

		try {
			await runTranscribeAndSummarizePipeline(
				this.app,
				this.settings,
				{ blob: result.blob, mimeType: result.mimeType, baseName: savedFile?.basename ?? `meeting ${formatTimestampForFilename(new Date())}` },
				{ insertIntoActiveNote: true, onProgress: (status) => this.showPipelineProgress(status) }
			);
		} catch (error) {
			console.error("ai-transcribe-summary: transcribe & summarize failed", error);
			new Notice(`Transcribe & summarize failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.hidePipelineProgress();
		}
	}

	private async saveRecording(result: RecordingResult): Promise<TFile | undefined> {
		const folderPath = normalizePath(this.settings.audioFolder);
		const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!existingFolder) {
			await this.app.vault.createFolder(folderPath);
		} else if (!(existingFolder instanceof TFolder)) {
			new Notice(`Audio folder "${folderPath}" is not a folder - recording not saved.`);
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
		const icon = this.state === "paused" ? "⏸" : "🔴";
		const label = this.state === "paused" ? "Paused" : "Recording";
		this.statusBarItem.setText(`${icon} ${label} ${formatElapsed(elapsed)}`);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
