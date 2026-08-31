import { App, DropdownComponent, Notice, PluginSettingTab, Setting, TextAreaComponent, TextComponent } from "obsidian";
import type AiTranscribeSummaryPlugin from "./main";

/** Masks a text input as a secret (password-style dots), for API keys. */
function makeSecret(text: TextComponent): TextComponent {
	text.inputEl.type = "password";
	text.inputEl.autocapitalize = "off";
	text.inputEl.spellcheck = false;
	return text;
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const DEFAULT_SUMMARY_PROMPT = `You are summarizing a meeting transcript. Produce a structured, Teams-Copilot-style summary with these sections, in this order:

## Overview
2-3 sentences on what the meeting was about and its outcome.

## Topics Discussed
Group related points together by topic - do not just restate the transcript line-by-line.

## Decisions Made
Concrete decisions reached during the meeting. Omit this section if none were made.

## Action Items
A task list (- [ ] item). Include an owner and due date only if explicitly stated in the transcript - never guess or infer one.

## Open Questions / Follow-ups
Unresolved questions or items that need future discussion.

Never invent names, owners, dates, or facts that are not explicitly present in the transcript. If a section has no content, omit it rather than leaving it blank.`;

export const DEFAULT_CLEANUP_PROMPT = `You are cleaning up a raw speech-to-text meeting transcript. Rewrite it to be more readable while preserving meaning exactly:

- Remove filler words and verbal tics (um, uh, like, you know, so, I mean) when they carry no meaning.
- Fix grammar, punctuation, and sentence breaks.
- Remove false starts and repeated words/phrases from self-correction.
- Keep the same speaker's intent, wording, tone, and every fact, name, number, and decision exactly as said - never summarize, shorten, paraphrase away detail, or invent content.
- Preserve speaker labels/turns if present in the input.

Output only the cleaned transcript text, nothing else.`;

export type TranscriptionProviderId = "openai" | "openrouter";

export type TranscriptPlacement = "same-note" | "dedicated-file";

/** Recording bitrate in kbps. Kept as a closed set - MediaRecorder accepts arbitrary values, but only these are exposed. */
export type AudioBitrateKbps = 32 | 64 | 128;

export const AUDIO_BITRATE_OPTIONS: { value: AudioBitrateKbps; label: string }[] = [
	{ value: 32, label: "32 kbps (default - smallest files)" },
	{ value: 64, label: "64 kbps (better quality, ~2x file size)" },
	{ value: 128, label: "128 kbps (best quality, ~4x file size)" },
];

export const OPENAI_DEFAULT_MODEL = "whisper-1";

/** OpenRouter model ids are provider-prefixed (e.g. "openai/whisper-1"), unlike OpenAI's bare "whisper-1". */
export const OPENROUTER_DEFAULT_MODEL = "openai/whisper-1";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/openai/whisper-1";

export interface TranscriptionProviderSettingsMap {
	openai: {
		apiKey: string;
		model: string;
		baseUrl: string;
	};
	openrouter: {
		apiKey: string;
		model: string;
		baseUrl: string;
	};
}

/** The transcription provider whose key can be reused for summaries - only valid when the summary provider is the same host. */
export function transcriptionKeyReuseTarget(settings: AiTranscribeSummarySettings): TranscriptionProviderId {
	return settings.transcriptionProvider;
}

export type SummaryProviderId = "openai" | "openrouter";

export interface SummaryProviderSettingsMap {
	openai: { apiKey: string; model: string; baseUrl: string; temperature: number };
	openrouter: { apiKey: string; model: string; baseUrl: string; temperature: number };
}

/** Lower than the API default (usually 1.0) - summarization should stay close to the transcript, not get creative. */
export const DEFAULT_SUMMARY_TEMPERATURE = 0.3;

export interface AiTranscribeSummarySettings {
	// Active transcription provider + its per-provider config
	transcriptionProvider: TranscriptionProviderId;
	providers: TranscriptionProviderSettingsMap;

	// Active summary-generation provider + its per-provider config
	summaryProvider: SummaryProviderId;
	summaryProviders: SummaryProviderSettingsMap;
	summaryPrompt: string;
	/** When off, the pipeline stops after transcription - no LLM call, no summary note. */
	generateSummary: boolean;
	/** Reuse the transcription provider's own apiKey for summaries instead of a separate key. Only applies when summaryProvider matches transcriptionProvider (see transcriptionKeyReuseTarget). */
	reuseWhisperKeyForSummary: boolean;

	/** Optional LLM cleanup pass over the raw transcript before it's saved/summarized. Uses the summaryProvider's key/model. */
	cleanupTranscript: boolean;
	cleanupPrompt: string;

	// Custom vocabulary hints
	vocabularyHints: string;

	// Recording behavior
	microphoneDeviceId: string;
	audioBitrateKbps: AudioBitrateKbps;
	silenceAutoStopMinutes: number;
	maxRecordingHours: number;
	confirmBeforeStoppingRecording: boolean;

	// Output: raw audio
	saveAudioFile: boolean;
	audioFolder: string;

	// Output: full transcript
	transcriptPlacement: TranscriptPlacement;
	transcriptFolder: string;

	// Output: summary. Inserted at the cursor in the active note when one is
	// open (live recording); written into summaryFolder otherwise (no active
	// note, or a right-click retry, which never has an active-note context).
	summaryFolder: string;
}

export const DEFAULT_SETTINGS: AiTranscribeSummarySettings = {
	transcriptionProvider: "openrouter",
	providers: {
		openai: {
			apiKey: "",
			model: OPENAI_DEFAULT_MODEL,
			baseUrl: OPENAI_BASE_URL,
		},
		openrouter: {
			apiKey: "",
			model: OPENROUTER_DEFAULT_MODEL,
			baseUrl: OPENROUTER_BASE_URL,
		},
	},

	summaryProvider: "openai",
	summaryProviders: {
		openai: { apiKey: "", model: "gpt-4o-mini", baseUrl: OPENAI_BASE_URL, temperature: DEFAULT_SUMMARY_TEMPERATURE },
		openrouter: { apiKey: "", model: "openai/gpt-4o-mini", baseUrl: OPENROUTER_BASE_URL, temperature: DEFAULT_SUMMARY_TEMPERATURE },
	},
	summaryPrompt: DEFAULT_SUMMARY_PROMPT,
	generateSummary: true,
	reuseWhisperKeyForSummary: false,

	cleanupTranscript: false,
	cleanupPrompt: DEFAULT_CLEANUP_PROMPT,

	vocabularyHints: "",

	microphoneDeviceId: "",
	audioBitrateKbps: 32,
	silenceAutoStopMinutes: 5,
	maxRecordingHours: 3,
	confirmBeforeStoppingRecording: false,

	saveAudioFile: true,
	audioFolder: "_meetings/audio",

	transcriptPlacement: "same-note",
	transcriptFolder: "_meetings/transcripts",

	summaryFolder: "_meetings",
};

interface ProviderSettingsSchema<K extends TranscriptionProviderId> {
	id: K;
	label: string;
	description: string;
	render: (containerEl: HTMLElement, settings: TranscriptionProviderSettingsMap[K], onChange: () => Promise<void>) => void;
}

/** One entry per TranscriptionProvider implementation. */
const PROVIDER_SETTINGS_SCHEMA: {
	[K in TranscriptionProviderId]: ProviderSettingsSchema<K>;
} = {
	openai: {
		id: "openai",
		label: "OpenAI",
		description: "Uses the OpenAI Whisper transcription API directly. 25MB size ceiling, handled via silence-aware chunking.",
		render: (containerEl, settings, onChange) => {
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Used for Whisper transcription. Also used for summary generation unless a separate summary API key is set below.")
				.addText((text) =>
					makeSecret(text)
						.setPlaceholder("sk-...")
						.setValue(settings.apiKey)
						.onChange(async (value) => {
							settings.apiKey = value;
							await onChange();
						})
				);

			new Setting(containerEl)
				.setName("Model")
				.setDesc("Whisper model used for transcription.")
				.addText((text) =>
					text
						.setPlaceholder(OPENAI_DEFAULT_MODEL)
						.setValue(settings.model)
						.onChange(async (value) => {
							settings.model = value || OPENAI_DEFAULT_MODEL;
							await onChange();
						})
				);

			new Setting(containerEl)
				.setName("Base URL")
				.setDesc("Edit directly to point at a proxy or self-hosted endpoint.")
				.addText((text) =>
					text
						.setPlaceholder(OPENAI_BASE_URL)
						.setValue(settings.baseUrl)
						.onChange(async (value) => {
							settings.baseUrl = value || OPENAI_BASE_URL;
							await onChange();
						})
				);
		},
	},
	openrouter: {
		id: "openrouter",
		label: "OpenRouter",
		description: "Routes Whisper transcription through OpenRouter - often cheaper. 25MB size ceiling, handled via silence-aware chunking.",
		render: (containerEl, settings, onChange) => {
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Used for Whisper transcription. Also used for summary generation unless a separate summary API key is set below.")
				.addText((text) =>
					makeSecret(text)
						.setPlaceholder("sk-or-...")
						.setValue(settings.apiKey)
						.onChange(async (value) => {
							settings.apiKey = value;
							await onChange();
						})
				);

			new Setting(containerEl)
				.setName("Model")
				.setDesc(
					createFragment((el) => {
						el.appendText("OpenRouter model id, provider-prefixed (e.g. openai/whisper-1, not just whisper-1). See the id on ");
						el.createEl("a", { text: "OpenRouter's model page", href: OPENROUTER_MODELS_URL });
						el.appendText(" (shown under the model name); that page links to other transcription models too.");
					})
				)
				.addText((text) =>
					text
						.setPlaceholder(OPENROUTER_DEFAULT_MODEL)
						.setValue(settings.model)
						.onChange(async (value) => {
							settings.model = value || OPENROUTER_DEFAULT_MODEL;
							await onChange();
						})
				);

			new Setting(containerEl)
				.setName("Base URL")
				.setDesc("Edit directly to point at a proxy or self-hosted endpoint.")
				.addText((text) =>
					text
						.setPlaceholder(OPENROUTER_BASE_URL)
						.setValue(settings.baseUrl)
						.onChange(async (value) => {
							settings.baseUrl = value || OPENROUTER_BASE_URL;
							await onChange();
						})
				);
		},
	},
};

interface SummaryProviderSchemaEntry {
	label: string;
	description: string;
	apiKeyPlaceholder: string;
	modelPlaceholder: string;
}

/** One entry per summary-generation provider - both share the same (apiKey, model, baseUrl) shape, rendered by a single shared function. */
const SUMMARY_PROVIDER_SCHEMA: Record<SummaryProviderId, SummaryProviderSchemaEntry> = {
	openai: {
		label: "OpenAI",
		description: "Uses the OpenAI Chat Completions API directly.",
		apiKeyPlaceholder: "sk-...",
		modelPlaceholder: "gpt-4o-mini",
	},
	openrouter: {
		label: "OpenRouter",
		description: "Routes through OpenRouter - access to many models (including Anthropic and Google) via one key, often cheaper.",
		apiKeyPlaceholder: "sk-or-...",
		modelPlaceholder: "openai/gpt-4o-mini",
	},
};

const SUMMARY_PROVIDER_ORDER: SummaryProviderId[] = ["openai", "openrouter"];

const PROVIDER_ORDER: TranscriptionProviderId[] = ["openrouter", "openai"];

export class AiTranscribeSummarySettingTab extends PluginSettingTab {
	plugin: AiTranscribeSummaryPlugin;

	constructor(app: App, plugin: AiTranscribeSummaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderProviderSection(containerEl);
		this.renderSummarySection(containerEl);
		this.renderVocabularySection(containerEl);
		this.renderRecordingSection(containerEl);
		this.renderOutputSection(containerEl);
	}

	private renderProviderSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Transcription provider").setHeading();

		new Setting(containerEl)
			.setName("Transcription provider")
			.setDesc("Which service turns your recording's audio into text. Used both for live recordings and the right-click \"Transcribe & summarize\" action.")
			.addDropdown((dropdown) => {
				for (const providerId of PROVIDER_ORDER) {
					dropdown.addOption(providerId, PROVIDER_SETTINGS_SCHEMA[providerId].label);
				}
				dropdown.setValue(this.plugin.settings.transcriptionProvider).onChange(async (value) => {
					this.plugin.settings.transcriptionProvider = value as TranscriptionProviderId;
					await this.plugin.saveSettings();
					this.renderProviderSettings(providerFieldsEl, this.plugin.settings.transcriptionProvider);
				});
			});

		const providerFieldsEl = containerEl.createDiv();
		this.renderProviderSettings(providerFieldsEl, this.plugin.settings.transcriptionProvider);
	}

	/** Renders only the selected transcription provider's settings - the other provider's fields are hidden, not just visually de-emphasized, since only one is ever active. */
	private renderProviderSettings(containerEl: HTMLElement, providerId: TranscriptionProviderId): void {
		containerEl.empty();

		const schema = PROVIDER_SETTINGS_SCHEMA[providerId];
		containerEl.createEl("p", { text: schema.description, cls: "setting-item-description" });

		const onChange = async () => {
			await this.plugin.saveSettings();
		};

		this.renderProviderSchema(providerId, containerEl, onChange);
	}

	/** Ties a single TranscriptionProviderId to its schema and settings slice so TS can verify the pairing. */
	private renderProviderSchema<K extends TranscriptionProviderId>(
		providerId: K,
		containerEl: HTMLElement,
		onChange: () => Promise<void>
	): void {
		PROVIDER_SETTINGS_SCHEMA[providerId].render(containerEl, this.plugin.settings.providers[providerId], onChange);
	}

	private renderSummaryProviderFields<K extends SummaryProviderId>(containerEl: HTMLElement, providerId: K): void {
		containerEl.empty();

		const schema = SUMMARY_PROVIDER_SCHEMA[providerId];
		const settings = this.plugin.settings.summaryProviders[providerId];

		// Reuse only applies when this provider matches the transcription provider - otherwise the key would go to the wrong host.
		const reuseTarget = transcriptionKeyReuseTarget(this.plugin.settings);
		if ((providerId === "openai" || providerId === "openrouter") && providerId === reuseTarget) {
			const reuseHostLabel = reuseTarget === "openai" ? "OpenAI" : "OpenRouter";
			let apiKeySetting: Setting | undefined;
			new Setting(containerEl)
				.setName(`Reuse transcription (${reuseHostLabel}) API key`)
				.setDesc(`Transcription is currently configured to call ${reuseHostLabel} - reuse that same key for summary generation instead of a separate key here.`)
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.reuseWhisperKeyForSummary).onChange(async (value) => {
						this.plugin.settings.reuseWhisperKeyForSummary = value;
						await this.plugin.saveSettings();
						apiKeySetting?.settingEl.toggle(!value);
					})
				);

			apiKeySetting = new Setting(containerEl)
				.setName(`${schema.label} API key`)
				.setDesc(schema.description)
				.addText((text) =>
					makeSecret(text)
						.setPlaceholder(schema.apiKeyPlaceholder)
						.setValue(settings.apiKey)
						.onChange(async (value) => {
							settings.apiKey = value;
							await this.plugin.saveSettings();
						})
				);
			apiKeySetting.settingEl.toggle(!this.plugin.settings.reuseWhisperKeyForSummary);
		} else {
			new Setting(containerEl)
				.setName(`${schema.label} API key`)
				.setDesc(schema.description)
				.addText((text) =>
					makeSecret(text)
						.setPlaceholder(schema.apiKeyPlaceholder)
						.setValue(settings.apiKey)
						.onChange(async (value) => {
							settings.apiKey = value;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model used to generate the structured summary from the transcript.")
			.addText((text) =>
				text
					.setPlaceholder(schema.modelPlaceholder)
					.setValue(settings.model)
					.onChange(async (value) => {
						settings.model = value || schema.modelPlaceholder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc(
				`Randomness of the generated summary, from 0 (deterministic, sticks close to the transcript) to 2 (more creative, more prone to inventing details). Default ${DEFAULT_SUMMARY_TEMPERATURE} favors accuracy.`
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SUMMARY_TEMPERATURE))
					.setValue(String(settings.temperature))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
							settings.temperature = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("Edit directly to point at a proxy or self-hosted endpoint.")
			.addText((text) =>
				text
					.setPlaceholder(settings.baseUrl)
					.setValue(settings.baseUrl)
					.onChange(async (value) => {
						settings.baseUrl = value || DEFAULT_SETTINGS.summaryProviders[providerId].baseUrl;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderSummarySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Summary generation").setHeading();

		let detailsEl: HTMLElement | undefined;
		new Setting(containerEl)
			.setName("Generate summary after transcription")
			.setDesc("When off, recording/retry stops after transcription - the transcript is saved but no LLM call is made and no summary note is created.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.generateSummary).onChange(async (value) => {
					this.plugin.settings.generateSummary = value;
					await this.plugin.saveSettings();
					detailsEl?.toggle(value);
				})
			);

		detailsEl = containerEl.createDiv();
		detailsEl.toggle(this.plugin.settings.generateSummary);

		new Setting(detailsEl)
			.setName("Summary provider")
			.setDesc("Which LLM provider generates the structured summary from the transcript.")
			.addDropdown((dropdown) => {
				for (const providerId of SUMMARY_PROVIDER_ORDER) {
					dropdown.addOption(providerId, SUMMARY_PROVIDER_SCHEMA[providerId].label);
				}
				dropdown.setValue(this.plugin.settings.summaryProvider).onChange(async (value) => {
					this.plugin.settings.summaryProvider = value as SummaryProviderId;
					await this.plugin.saveSettings();
					this.renderSummaryProviderFields(providerFieldsEl, this.plugin.settings.summaryProvider);
				});
			});

		const providerFieldsEl = detailsEl.createDiv();
		this.renderSummaryProviderFields(providerFieldsEl, this.plugin.settings.summaryProvider);

		let promptTextArea: TextAreaComponent | undefined;
		new Setting(detailsEl)
			.setClass("ai-transcribe-summary-prompt-setting")
			.setName("Summary prompt")
			.setDesc(
				"Instructions sent to the LLM to turn a transcript into a structured summary (Overview, Topics Discussed, Decisions Made, Action Items, Open Questions). Customize the wording, but keep it from inventing names/owners/dates not present in the transcript."
			)
			.addTextArea((text) => {
				promptTextArea = text;
				text
					.setPlaceholder(DEFAULT_SUMMARY_PROMPT)
					.setValue(this.plugin.settings.summaryPrompt)
					.onChange(async (value) => {
						this.plugin.settings.summaryPrompt = value || DEFAULT_SUMMARY_PROMPT;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.addClass("ai-transcribe-summary-prompt");
			});

		new Setting(detailsEl)
			.setClass("ai-transcribe-summary-prompt-reset")
			.addButton((button) =>
				button
					.setIcon("rotate-ccw")
					.setButtonText("Reset to default prompt")
					.onClick(async () => {
						this.plugin.settings.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
						await this.plugin.saveSettings();
						promptTextArea?.setValue(DEFAULT_SUMMARY_PROMPT);
					})
			);
	}

	private renderVocabularySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Custom vocabulary").setHeading();

		new Setting(containerEl)
			.setName("Vocabulary hints")
			.setDesc(
				"Comma-separated names, jargon, or project terms to reduce misrecognition of recurring vocabulary. Passed to the transcription provider where supported."
			)
			.addTextArea((text) => {
				text
					.setPlaceholder(" Obsidian, Whisper, sprint retro")
					.setValue(this.plugin.settings.vocabularyHints)
					.onChange(async (value) => {
						this.plugin.settings.vocabularyHints = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 3;
			});
	}

	/** Device labels are only populated once mic permission is granted, so a refresh button re-requests access and re-enumerates. */
	private renderMicrophoneSetting(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("Microphone")
			.setDesc("Input device used when recording. Falls back to the system default if the saved device is unavailable.");

		let dropdown: DropdownComponent | undefined;
		setting.addDropdown((dd) => {
			dropdown = dd;
			dd.addOption("", "System default");
			dd.setValue(this.plugin.settings.microphoneDeviceId).onChange(async (value) => {
				this.plugin.settings.microphoneDeviceId = value;
				await this.plugin.saveSettings();
			});
		});

		setting.addExtraButton((button) =>
			button
				.setIcon("refresh-cw")
				.setTooltip("Request microphone access & refresh device list")
				.onClick(async () => {
					await this.populateMicrophoneOptions(dropdown, { requestPermission: true });
				})
		);

		// Without permission most platforms return zero audioinput entries, so request it up front.
		void this.populateMicrophoneOptions(dropdown, { requestPermission: true, silent: true });
	}

	private async populateMicrophoneOptions(
		dropdown: DropdownComponent | undefined,
		{ requestPermission, silent = false }: { requestPermission: boolean; silent?: boolean }
	): Promise<void> {
		if (!dropdown) return;

		if (requestPermission) {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				stream.getTracks().forEach((track) => track.stop());
			} catch (error) {
				console.error("ai-transcribe-summary: microphone permission request failed", error);
				if (!silent) {
					new Notice("Microphone access was denied or unavailable. Check your OS privacy settings for Obsidian.");
				}
			}
		}

		let devices: MediaDeviceInfo[];
		try {
			devices = await navigator.mediaDevices.enumerateDevices();
		} catch (error) {
			console.error("ai-transcribe-summary: failed to enumerate media devices", error);
			if (!silent) {
				new Notice("Could not list audio devices - see console for details.");
			}
			return;
		}

		const mics = devices.filter((device) => device.kind === "audioinput");
		if (mics.length === 0 && !silent) {
			new Notice("No microphones found. Grant microphone access and try again.");
		}

		const selectEl = dropdown.selectEl;
		const currentValue = this.plugin.settings.microphoneDeviceId;

		selectEl.empty();
		dropdown.addOption("", "System default");
		mics.forEach((mic, index) => {
			dropdown.addOption(mic.deviceId, mic.label || `Microphone ${index + 1}`);
		});

		const hasCurrentDevice = currentValue === "" || mics.some((mic) => mic.deviceId === currentValue);
		dropdown.setValue(hasCurrentDevice ? currentValue : "");
	}

	private renderRecordingSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Recording").setHeading();

		this.renderMicrophoneSetting(containerEl);

		new Setting(containerEl)
			.setName("Audio bitrate")
			.setDesc("Recording quality vs. file size. Lower bitrates keep recordings under Whisper's 25MB ceiling for longer before chunking kicks in.")
			.addDropdown((dropdown) => {
				for (const option of AUDIO_BITRATE_OPTIONS) {
					dropdown.addOption(String(option.value), option.label);
				}
				dropdown.setValue(String(this.plugin.settings.audioBitrateKbps)).onChange(async (value) => {
					this.plugin.settings.audioBitrateKbps = Number(value) as AudioBitrateKbps;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Silence auto-stop (minutes)")
			.setDesc("Recording auto-stops after this many minutes of near-silence.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.silenceAutoStopMinutes))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.silenceAutoStopMinutes = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Max recording duration (hours)")
			.setDesc("Hard backstop: recording always stops after this many hours, regardless of silence detection.")
			.addText((text) =>
				text
					.setPlaceholder("3")
					.setValue(String(this.plugin.settings.maxRecordingHours))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.maxRecordingHours = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Confirm before stopping")
			.setDesc("Ask for confirmation before stopping an in-progress recording, to guard against an accidental click or hotkey press.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.confirmBeforeStoppingRecording).onChange(async (value) => {
					this.plugin.settings.confirmBeforeStoppingRecording = value;
					await this.plugin.saveSettings();
				})
			);
	}

	private renderOutputSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Output").setHeading();

		this.renderAudioOutputSettings(containerEl);
		this.renderTranscriptOutputSettings(containerEl);
		this.renderSummaryOutputSettings(containerEl);
	}

	private renderAudioOutputSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Raw audio").setHeading();

		let folderSetting: Setting | undefined;
		const updateFolderVisibility = () => {
			folderSetting?.settingEl.toggle(this.plugin.settings.saveAudioFile);
		};

		new Setting(containerEl)
			.setName("Save audio file")
			.setDesc(
				"Always preserve the recorded audio to the vault, regardless of whether transcription or summarization succeeds. Recommended to leave on - it's the only guaranteed record if a downstream step fails."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.saveAudioFile).onChange(async (value) => {
					this.plugin.settings.saveAudioFile = value;
					await this.plugin.saveSettings();
					updateFolderVisibility();
				})
			);

		folderSetting = new Setting(containerEl)
			.setName("Audio folder")
			.setDesc("Vault folder audio recordings are saved to.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.audioFolder)
					.setValue(this.plugin.settings.audioFolder)
					.onChange(async (value) => {
						this.plugin.settings.audioFolder = value || DEFAULT_SETTINGS.audioFolder;
						await this.plugin.saveSettings();
					})
			);
		updateFolderVisibility();
	}

	private renderTranscriptOutputSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Transcript").setHeading();

		let folderSetting: Setting | undefined;
		const updateFolderVisibility = () => {
			folderSetting?.settingEl.toggle(this.plugin.settings.transcriptPlacement === "dedicated-file");
		};

		new Setting(containerEl)
			.setName("Transcript placement")
			.setDesc(
				"Where the full raw transcript is written, relative to the summary. 'Same note' means whichever note the summary actually lands in - the active note if one was open, or the new note created in the summary folder otherwise."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("same-note", "Same note, below summary")
					.addOption("dedicated-file", "Dedicated file")
					.setValue(this.plugin.settings.transcriptPlacement)
					.onChange(async (value) => {
						this.plugin.settings.transcriptPlacement = value as TranscriptPlacement;
						await this.plugin.saveSettings();
						updateFolderVisibility();
					})
			);

		folderSetting = new Setting(containerEl)
			.setName("Transcript folder")
			.setDesc("Vault folder used when transcript placement is 'Dedicated file'.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.transcriptFolder)
					.setValue(this.plugin.settings.transcriptFolder)
					.onChange(async (value) => {
						this.plugin.settings.transcriptFolder = value || DEFAULT_SETTINGS.transcriptFolder;
						await this.plugin.saveSettings();
					})
			);
		updateFolderVisibility();

		let cleanupDetailsEl: HTMLElement | undefined;
		new Setting(containerEl)
			.setName("Clean up transcript")
			.setDesc(
				"Run the transcript through the summary provider/model configured above to remove filler words, false starts, and grammar mistakes before it's saved or summarized. Adds one extra LLM call per recording."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.cleanupTranscript).onChange(async (value) => {
					this.plugin.settings.cleanupTranscript = value;
					await this.plugin.saveSettings();
					cleanupDetailsEl?.toggle(value);
				})
			);

		cleanupDetailsEl = containerEl.createDiv();
		cleanupDetailsEl.toggle(this.plugin.settings.cleanupTranscript);

		let cleanupPromptTextArea: TextAreaComponent | undefined;
		new Setting(cleanupDetailsEl)
			.setClass("ai-transcribe-summary-prompt-setting")
			.setName("Cleanup prompt")
			.setDesc("Instructions sent to the LLM to clean up the raw transcript. Customize the wording, but keep it from summarizing, shortening, or inventing content.")
			.addTextArea((text) => {
				cleanupPromptTextArea = text;
				text
					.setPlaceholder(DEFAULT_CLEANUP_PROMPT)
					.setValue(this.plugin.settings.cleanupPrompt)
					.onChange(async (value) => {
						this.plugin.settings.cleanupPrompt = value || DEFAULT_CLEANUP_PROMPT;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 8;
				text.inputEl.addClass("ai-transcribe-summary-prompt");
			});

		new Setting(cleanupDetailsEl)
			.setClass("ai-transcribe-summary-prompt-reset")
			.addButton((button) =>
				button
					.setIcon("rotate-ccw")
					.setButtonText("Reset to default prompt")
					.onClick(async () => {
						this.plugin.settings.cleanupPrompt = DEFAULT_CLEANUP_PROMPT;
						await this.plugin.saveSettings();
						cleanupPromptTextArea?.setValue(DEFAULT_CLEANUP_PROMPT);
					})
			);
	}

	private renderSummaryOutputSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Summary").setHeading();

		new Setting(containerEl)
			.setName("Summary folder")
			.setDesc(
				"Where the summary is written when there's no active note to insert it into at the cursor (nothing open, or a right-click 'Transcribe & summarize' retry, which always writes here using the audio filename). If transcript placement above is 'Same note', the transcript follows the summary into this new note too."
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.summaryFolder)
					.setValue(this.plugin.settings.summaryFolder)
					.onChange(async (value) => {
						this.plugin.settings.summaryFolder = value || DEFAULT_SETTINGS.summaryFolder;
						await this.plugin.saveSettings();
					})
			);
	}
}
