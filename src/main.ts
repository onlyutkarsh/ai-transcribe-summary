import { Plugin } from "obsidian";
import { AiTranscribeSummarySettingTab, AiTranscribeSummarySettings, DEFAULT_SETTINGS } from "./settings";

export default class AiTranscribeSummaryPlugin extends Plugin {
	declare settings: AiTranscribeSummarySettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("mic", "Start meeting recording", () => {
			// TODO: wire up recording start/stop (Tier 2)
			console.log("ai-transcribe-summary: ribbon icon clicked, yay!");
		});

		this.addCommand({
			id: "start-recording",
			name: "Start meeting recording",
			callback: () => {
				// TODO: implement
			},
		});

		this.addSettingTab(new AiTranscribeSummarySettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
