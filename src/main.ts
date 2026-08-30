import { Plugin } from "obsidian";
import { AiTranscribeSummarySettingTab, AiTranscribeSummarySettings, DEFAULT_SETTINGS } from "./settings";

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

type RecordingState = "idle" | "recording" | "paused";

export default class AiTranscribeSummaryPlugin extends Plugin {
	declare settings: AiTranscribeSummarySettings;

	private statusBarItem!: HTMLElement;
	private state: RecordingState = "idle";
	private segmentStartedAt = 0;
	private accumulatedMs = 0;
	private timerIntervalId: number | undefined;
	private ribbonIconEl!: HTMLElement;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.hide();

		this.ribbonIconEl = this.addRibbonIcon("mic", "Start meeting recording", () => {
			this.toggleRecording();
		});

		this.addCommand({
			id: "start-recording",
			name: "Start recording",
			checkCallback: (checking) => {
				if (this.state !== "idle") return false;
				if (!checking) this.startRecording();
				return true;
			},
		});

		this.addCommand({
			id: "stop-recording",
			name: "Stop recording",
			checkCallback: (checking) => {
				if (this.state === "idle") return false;
				if (!checking) this.stopRecording();
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
	}

	onunload() {
		this.stopTimer();
	}

	private toggleRecording() {
		if (this.state === "idle") {
			this.startRecording();
		} else {
			this.stopRecording();
		}
	}

	private togglePause() {
		if (this.state === "recording") {
			this.pauseRecording();
		} else if (this.state === "paused") {
			this.resumeRecording();
		}
	}

	private startRecording() {
		// TODO: wire up actual audio capture via provider abstraction layer (Tier 2)
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
		this.accumulatedMs += Date.now() - this.segmentStartedAt;
		this.state = "paused";
		this.stopTimer();
		this.updateStatusBar();
	}

	private resumeRecording() {
		this.segmentStartedAt = Date.now();
		this.state = "recording";
		this.updateStatusBar();
		this.startTimer();
	}

	private stopRecording() {
		this.state = "idle";
		this.stopTimer();

		this.ribbonIconEl.removeClass("is-active");
		this.ribbonIconEl.setAttribute("aria-label", "Start meeting recording");

		this.statusBarItem.hide();
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
