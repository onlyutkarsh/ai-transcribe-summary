import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	SettingDefinitionItem,
	SettingGroupItem,
	TextAreaComponent,
	TextComponent,
} from "obsidian";
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
/** Gemini's OpenAI-compatible endpoint - lets GeminiSummaryProvider reuse the same Chat Completions request/response shape as OpenAI/OpenRouter. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

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

/** ISO-639-1 codes for Whisper's most commonly used languages, sorted by display name. Not exhaustive - Whisper supports ~100 languages - but covers the common case without risking a typo'd code silently degrading transcription quality. */
export const TRANSCRIPTION_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
	{ value: "ar", label: "Arabic" },
	{ value: "zh", label: "Chinese" },
	{ value: "nl", label: "Dutch" },
	{ value: "en", label: "English" },
	{ value: "fi", label: "Finnish" },
	{ value: "fr", label: "French" },
	{ value: "de", label: "German" },
	{ value: "hi", label: "Hindi" },
	{ value: "id", label: "Indonesian" },
	{ value: "it", label: "Italian" },
	{ value: "ja", label: "Japanese" },
	{ value: "ko", label: "Korean" },
	{ value: "pl", label: "Polish" },
	{ value: "pt", label: "Portuguese" },
	{ value: "ru", label: "Russian" },
	{ value: "es", label: "Spanish" },
	{ value: "sv", label: "Swedish" },
	{ value: "th", label: "Thai" },
	{ value: "tr", label: "Turkish" },
	{ value: "uk", label: "Ukrainian" },
	{ value: "vi", label: "Vietnamese" },
];

export const OPENAI_DEFAULT_MODEL = "whisper-1";

/** OpenRouter model ids are provider-prefixed (e.g. "openai/whisper-1"), unlike OpenAI's bare "whisper-1". */
export const OPENROUTER_DEFAULT_MODEL = "openai/whisper-1";

export const OPENROUTER_WHISPER_MODEL_URL = "https://openrouter.ai/openai/whisper-1";

/** OpenRouter's full model catalog - used for summary/LLM model ids (as opposed to the transcription-specific Whisper page). */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/models";

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

export type SummaryProviderId = "openai" | "openrouter" | "gemini";

export interface SummaryProviderSettingsMap {
	openai: { apiKey: string; model: string; baseUrl: string; temperature: number };
	openrouter: { apiKey: string; model: string; baseUrl: string; temperature: number };
	gemini: { apiKey: string; model: string; baseUrl: string; temperature: number };
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

	/** ISO-639-1 code (e.g. "en", "es"). Empty means let Whisper auto-detect the language. */
	transcriptionLanguage: string;

	// Recording behavior
	microphoneDeviceId: string;
	audioBitrateKbps: AudioBitrateKbps;
	silenceAutoStopMinutes: number;
	maxRecordingHours: number;
	confirmBeforeStartingRecording: boolean;
	confirmBeforeStoppingRecording: boolean;

	// Output: raw audio
	saveAudioFile: boolean;
	audioFolder: string;

	// Output: full transcript
	transcriptPlacement: TranscriptPlacement;
	transcriptFolder: string;

	// Output: summary. Inserted at the cursor in the active note when one is
	// open (live recording, or a right-click retry with a markdown note still
	// open); written into summaryFolder otherwise (no active note).
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
		gemini: { apiKey: "", model: "gemini-3.7-flash", baseUrl: GEMINI_BASE_URL, temperature: DEFAULT_SUMMARY_TEMPERATURE },
	},
	summaryPrompt: DEFAULT_SUMMARY_PROMPT,
	generateSummary: true,
	reuseWhisperKeyForSummary: false,

	cleanupTranscript: false,
	cleanupPrompt: DEFAULT_CLEANUP_PROMPT,

	vocabularyHints: "",
	transcriptionLanguage: "",

	microphoneDeviceId: "",
	audioBitrateKbps: 32,
	silenceAutoStopMinutes: 5,
	maxRecordingHours: 3,
	confirmBeforeStartingRecording: false,
	confirmBeforeStoppingRecording: false,

	saveAudioFile: true,
	audioFolder: "_meetings/audio",

	transcriptPlacement: "same-note",
	transcriptFolder: "_meetings/transcripts",

	summaryFolder: "_meetings",
};

interface TranscriptionProviderSchemaEntry {
	label: string;
	description: string;
	apiKeyPlaceholder: string;
	modelPlaceholder: string;
	/** Only OpenRouter needs a link out to its model-id page; everyone else gets a plain description. */
	modelDesc: string | DocumentFragment;
}

/** One entry per TranscriptionProvider implementation - both share the same (apiKey, model, baseUrl) shape. */
const PROVIDER_SETTINGS_SCHEMA: Record<TranscriptionProviderId, TranscriptionProviderSchemaEntry> = {
	openai: {
		label: "OpenAI",
		description: "Uses the OpenAI Whisper transcription API directly. 25MB size ceiling, handled via silence-aware chunking.",
		apiKeyPlaceholder: "sk-...",
		modelPlaceholder: OPENAI_DEFAULT_MODEL,
		modelDesc: "Whisper model used for transcription.",
	},
	openrouter: {
		label: "OpenRouter",
		description: "Routes Whisper transcription through OpenRouter - often cheaper. 25MB size ceiling, handled via silence-aware chunking.",
		apiKeyPlaceholder: "sk-or-...",
		modelPlaceholder: OPENROUTER_DEFAULT_MODEL,
		modelDesc: createFragment((el) => {
			el.appendText("OpenRouter model id, provider-prefixed (e.g. openai/whisper-1, not just whisper-1). See the id on ");
			el.createEl("a", { text: "OpenRouter's model page", href: OPENROUTER_WHISPER_MODEL_URL });
			el.appendText(" (shown under the model name); that page links to other transcription models too.");
		}),
	},
};

interface SummaryProviderSchemaEntry {
	label: string;
	/** Only Gemini needs a link out to its key-creation page; everyone else gets a plain description. */
	description: string | DocumentFragment;
	apiKeyPlaceholder: string;
	modelPlaceholder: string;
	/** Only OpenRouter and Gemini need a link out to their model catalog; everyone else gets a plain description. */
	modelDesc: string | DocumentFragment;
}

/** One entry per summary-generation provider - both share the same (apiKey, model, baseUrl, temperature) shape. */
export const SUMMARY_PROVIDER_SCHEMA: Record<SummaryProviderId, SummaryProviderSchemaEntry> = {
	openai: {
		label: "OpenAI",
		description: createFragment((el) => {
			el.appendText("Uses the OpenAI Chat Completions API directly. Get a key from the ");
			el.createEl("a", { text: "OpenAI API keys page", href: "https://platform.openai.com/api-keys" });
			el.appendText(".");
		}),
		apiKeyPlaceholder: "sk-...",
		modelPlaceholder: "gpt-4o-mini",
		modelDesc: createFragment((el) => {
			el.appendText("Model used to generate the structured summary from the transcript. See available models in the ");
			el.createEl("a", { text: "OpenAI models docs", href: "https://platform.openai.com/docs/models" });
			el.appendText(".");
		}),
	},
	openrouter: {
		label: "OpenRouter",
		description: "Routes through OpenRouter - access to many models (including Anthropic and Google) via one key, often cheaper.",
		apiKeyPlaceholder: "sk-or-...",
		modelPlaceholder: "openai/gpt-4o-mini",
		modelDesc: createFragment((el) => {
			el.appendText("OpenRouter model id, provider-prefixed (e.g. openai/gpt-4o-mini, not just gpt-4o-mini). Browse available models on ");
			el.createEl("a", { text: "OpenRouter's model page", href: OPENROUTER_MODELS_URL });
			el.appendText(".");
		}),
	},
	gemini: {
		label: "Google Gemini",
		description: createFragment((el) => {
			el.appendText("Uses Google's Gemini API directly, via its OpenAI-compatible endpoint. Get a key from ");
			el.createEl("a", { text: "Google AI Studio", href: "https://aistudio.google.com/apikey" });
			el.appendText(".");
		}),
		apiKeyPlaceholder: "AIza...",
		modelPlaceholder: "gemini-3.7-flash",
		modelDesc: createFragment((el) => {
			el.appendText("Gemini model used to generate the structured summary from the transcript. See available models in the ");
			el.createEl("a", { text: "Gemini API docs", href: "https://ai.google.dev/gemini-api/docs/models" });
			el.appendText(".");
		}),
	},
};

const SUMMARY_PROVIDER_ORDER: SummaryProviderId[] = ["openai", "openrouter", "gemini"];

const PROVIDER_ORDER: TranscriptionProviderId[] = ["openrouter", "openai"];

/** Keys that gate another definition's `visible` predicate - writing one of these needs a refreshDomState() to update the DOM without a full structural rebuild. */
const VISIBILITY_DRIVING_KEYS = new Set<string>([
	"transcriptionProvider",
	"summaryProvider",
	"generateSummary",
	"cleanupTranscript",
	"saveAudioFile",
	"transcriptPlacement",
	"reuseWhisperKeyForSummary.openai",
	"reuseWhisperKeyForSummary.openrouter",
	"reuseWhisperKeyForSummary.gemini",
]);

export class AiTranscribeSummarySettingTab extends PluginSettingTab {
	plugin: AiTranscribeSummaryPlugin;
	private microphoneDropdown: DropdownComponent | undefined;
	private summaryPromptTextArea: TextAreaComponent | undefined;
	private cleanupPromptTextArea: TextAreaComponent | undefined;

	constructor(app: App, plugin: AiTranscribeSummaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.buildTranscriptionGroup(),
			this.buildSummaryGroup(),
			this.buildVocabularyGroup(),
			this.buildRecordingBehaviorGroup(),
			this.buildInterfaceGroup(),
			this.buildSupportGroup(),
		];
	}

	/** Always explicit, never relying on the base class's default read path - keeps behavior for nested settings fully within this file. */
	getControlValue(key: string): unknown {
		const settings = this.plugin.settings;
		switch (key) {
			case "transcriptionProvider":
				return settings.transcriptionProvider;
			case "providers.openai.model":
				return settings.providers.openai.model;
			case "providers.openai.baseUrl":
				return settings.providers.openai.baseUrl;
			case "providers.openrouter.model":
				return settings.providers.openrouter.model;
			case "providers.openrouter.baseUrl":
				return settings.providers.openrouter.baseUrl;
			case "generateSummary":
				return settings.generateSummary;
			case "summaryProvider":
				return settings.summaryProvider;
			case "reuseWhisperKeyForSummary.openai":
			case "reuseWhisperKeyForSummary.openrouter":
			case "reuseWhisperKeyForSummary.gemini":
				return settings.reuseWhisperKeyForSummary;
			case "summaryProviders.openai.model":
				return settings.summaryProviders.openai.model;
			case "summaryProviders.openai.temperature":
				return settings.summaryProviders.openai.temperature;
			case "summaryProviders.openai.baseUrl":
				return settings.summaryProviders.openai.baseUrl;
			case "summaryProviders.openrouter.model":
				return settings.summaryProviders.openrouter.model;
			case "summaryProviders.openrouter.temperature":
				return settings.summaryProviders.openrouter.temperature;
			case "summaryProviders.openrouter.baseUrl":
				return settings.summaryProviders.openrouter.baseUrl;
			case "summaryProviders.gemini.model":
				return settings.summaryProviders.gemini.model;
			case "summaryProviders.gemini.temperature":
				return settings.summaryProviders.gemini.temperature;
			case "summaryProviders.gemini.baseUrl":
				return settings.summaryProviders.gemini.baseUrl;
			case "summaryPrompt":
				return settings.summaryPrompt;
			case "vocabularyHints":
				return settings.vocabularyHints;
			case "transcriptionLanguage":
				return settings.transcriptionLanguage;
			case "audioBitrateKbps":
				return String(settings.audioBitrateKbps);
			case "silenceAutoStopMinutes":
				return settings.silenceAutoStopMinutes;
			case "maxRecordingHours":
				return settings.maxRecordingHours;
			case "confirmBeforeStartingRecording":
				return settings.confirmBeforeStartingRecording;
			case "confirmBeforeStoppingRecording":
				return settings.confirmBeforeStoppingRecording;
			case "saveAudioFile":
				return settings.saveAudioFile;
			case "audioFolder":
				return settings.audioFolder;
			case "transcriptPlacement":
				return settings.transcriptPlacement;
			case "transcriptFolder":
				return settings.transcriptFolder;
			case "cleanupTranscript":
				return settings.cleanupTranscript;
			case "cleanupPrompt":
				return settings.cleanupPrompt;
			case "summaryFolder":
				return settings.summaryFolder;
			default:
				return undefined;
		}
	}

	/** Parses and range-checks a summary-provider temperature; returns undefined (reject) when invalid. */
	private static parseTemperature(value: unknown): number | undefined {
		const temperature = Number(value);
		return Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : undefined;
	}

	/** Always explicit, always calls saveSettings() itself - never relies on any assumed default write path. */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key) {
			case "transcriptionProvider":
				settings.transcriptionProvider = value as TranscriptionProviderId;
				break;
			case "providers.openai.model":
				settings.providers.openai.model = (value as string) || OPENAI_DEFAULT_MODEL;
				break;
			case "providers.openai.baseUrl":
				settings.providers.openai.baseUrl = (value as string) || OPENAI_BASE_URL;
				break;
			case "providers.openrouter.model":
				settings.providers.openrouter.model = (value as string) || OPENROUTER_DEFAULT_MODEL;
				break;
			case "providers.openrouter.baseUrl":
				settings.providers.openrouter.baseUrl = (value as string) || OPENROUTER_BASE_URL;
				break;
			case "generateSummary":
				settings.generateSummary = value as boolean;
				break;
			case "summaryProvider":
				settings.summaryProvider = value as SummaryProviderId;
				break;
			case "reuseWhisperKeyForSummary.openai":
			case "reuseWhisperKeyForSummary.openrouter":
			case "reuseWhisperKeyForSummary.gemini":
				settings.reuseWhisperKeyForSummary = value as boolean;
				break;
			case "summaryProviders.openai.model":
				settings.summaryProviders.openai.model = (value as string) || SUMMARY_PROVIDER_SCHEMA.openai.modelPlaceholder;
				break;
			case "summaryProviders.openai.temperature": {
				const temperature = AiTranscribeSummarySettingTab.parseTemperature(value);
				if (temperature === undefined) return;
				settings.summaryProviders.openai.temperature = temperature;
				break;
			}
			case "summaryProviders.openai.baseUrl":
				settings.summaryProviders.openai.baseUrl = (value as string) || DEFAULT_SETTINGS.summaryProviders.openai.baseUrl;
				break;
			case "summaryProviders.openrouter.model":
				settings.summaryProviders.openrouter.model = (value as string) || SUMMARY_PROVIDER_SCHEMA.openrouter.modelPlaceholder;
				break;
			case "summaryProviders.openrouter.temperature": {
				const temperature = AiTranscribeSummarySettingTab.parseTemperature(value);
				if (temperature === undefined) return;
				settings.summaryProviders.openrouter.temperature = temperature;
				break;
			}
			case "summaryProviders.openrouter.baseUrl":
				settings.summaryProviders.openrouter.baseUrl = (value as string) || DEFAULT_SETTINGS.summaryProviders.openrouter.baseUrl;
				break;
			case "summaryProviders.gemini.model":
				settings.summaryProviders.gemini.model = (value as string) || SUMMARY_PROVIDER_SCHEMA.gemini.modelPlaceholder;
				break;
			case "summaryProviders.gemini.temperature": {
				const temperature = AiTranscribeSummarySettingTab.parseTemperature(value);
				if (temperature === undefined) return;
				settings.summaryProviders.gemini.temperature = temperature;
				break;
			}
			case "summaryProviders.gemini.baseUrl":
				settings.summaryProviders.gemini.baseUrl = (value as string) || DEFAULT_SETTINGS.summaryProviders.gemini.baseUrl;
				break;
			case "summaryPrompt":
				settings.summaryPrompt = (value as string) || DEFAULT_SUMMARY_PROMPT;
				break;
			case "vocabularyHints":
				settings.vocabularyHints = value as string;
				break;
			case "transcriptionLanguage":
				settings.transcriptionLanguage = value as string;
				break;
			case "audioBitrateKbps":
				settings.audioBitrateKbps = Number(value) as AudioBitrateKbps;
				break;
			case "silenceAutoStopMinutes":
				settings.silenceAutoStopMinutes = value as number;
				break;
			case "maxRecordingHours":
				settings.maxRecordingHours = value as number;
				break;
			case "confirmBeforeStartingRecording":
				settings.confirmBeforeStartingRecording = value as boolean;
				break;
			case "confirmBeforeStoppingRecording":
				settings.confirmBeforeStoppingRecording = value as boolean;
				break;
			case "saveAudioFile":
				settings.saveAudioFile = value as boolean;
				break;
			case "audioFolder":
				settings.audioFolder = (value as string) || DEFAULT_SETTINGS.audioFolder;
				break;
			case "transcriptPlacement":
				settings.transcriptPlacement = value as TranscriptPlacement;
				break;
			case "transcriptFolder":
				settings.transcriptFolder = (value as string) || DEFAULT_SETTINGS.transcriptFolder;
				break;
			case "cleanupTranscript":
				settings.cleanupTranscript = value as boolean;
				break;
			case "cleanupPrompt":
				settings.cleanupPrompt = (value as string) || DEFAULT_CLEANUP_PROMPT;
				break;
			case "summaryFolder":
				settings.summaryFolder = (value as string) || DEFAULT_SETTINGS.summaryFolder;
				break;
			default:
				return;
		}

		await this.plugin.saveSettings();

		if (VISIBILITY_DRIVING_KEYS.has(key)) {
			this.refreshDomState();
		}
	}

	private buildTranscriptionGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Transcription",
			items: [
				{
					name: "Transcription provider",
					desc: 'Which service turns your recording\'s audio into text. Used both for live recordings and the right-click "Transcribe & summarize" action.',
					control: {
						type: "dropdown",
						key: "transcriptionProvider",
						options: Object.fromEntries(PROVIDER_ORDER.map((id) => [id, PROVIDER_SETTINGS_SCHEMA[id].label])),
					},
				},
				{
					name: "Speaking language",
					desc: "Language spoken in your recordings. The transcript is written in this language, not translated - setting this just improves accuracy and speed, especially for short or accented recordings. Leave on auto-detect if recordings mix languages or aren't in the list.",
					control: {
						type: "dropdown",
						key: "transcriptionLanguage",
						options: {
							"": "Auto-detect",
							...Object.fromEntries(TRANSCRIPTION_LANGUAGE_OPTIONS.map((option) => [option.value, option.label])),
						},
					},
				},
				...this.buildTranscriptionProviderFields("openai"),
				...this.buildTranscriptionProviderFields("openrouter"),
				{
					name: "Transcript placement",
					desc: "Where the full raw transcript is written, relative to the summary. 'Same note' means whichever note the summary actually lands in - the active note if one was open, or the new note created in the summary folder otherwise.",
					visible: () => this.plugin.settings.generateSummary,
					control: {
						type: "dropdown",
						key: "transcriptPlacement",
						options: {
							"same-note": "Same note, below summary",
							"dedicated-file": "Dedicated file",
						},
					},
				},
				{
					name: "Transcript folder",
					desc: "Vault folder used when transcript placement is 'Dedicated file', or always when summary generation is off (the transcript then always gets its own note here, since there's no summary for it to accompany).",
					visible: () => this.plugin.settings.transcriptPlacement === "dedicated-file" || !this.plugin.settings.generateSummary,
					control: {
						type: "folder",
						key: "transcriptFolder",
						placeholder: DEFAULT_SETTINGS.transcriptFolder,
						includeRoot: true,
					},
				},
			],
		};
	}

	private buildTranscriptionProviderFields(providerId: TranscriptionProviderId): SettingGroupItem[] {
		const schema = PROVIDER_SETTINGS_SCHEMA[providerId];
		const visible = () => this.plugin.settings.transcriptionProvider === providerId;

		return [
			{
				name: `${schema.label} provider info`,
				desc: schema.description,
				visible,
				render: () => {},
			},
			{
				name: `${schema.label} API key`,
				desc: "Used for Whisper transcription. Also used for summary generation unless a separate summary API key is set below.",
				visible,
				render: (setting) => {
					setting.addText((text) =>
						makeSecret(text)
							.setPlaceholder(schema.apiKeyPlaceholder)
							.setValue(this.plugin.settings.providers[providerId].apiKey)
							.onChange(async (value) => {
								this.plugin.settings.providers[providerId].apiKey = value;
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: `${schema.label} model`,
				desc: schema.modelDesc,
				visible,
				control: {
					type: "text",
					key: `providers.${providerId}.model`,
					placeholder: schema.modelPlaceholder,
				},
			},
			{
				name: `${schema.label} base URL`,
				desc: "Edit directly to point at a proxy or self-hosted endpoint.",
				visible,
				control: {
					type: "text",
					key: `providers.${providerId}.baseUrl`,
					placeholder: providerId === "openai" ? OPENAI_BASE_URL : OPENROUTER_BASE_URL,
				},
			},
		];
	}

	private buildSummaryGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Summary",
			items: [
				{
					name: "Generate summary after transcription",
					desc: "When off, recording/retry stops after transcription - the transcript is saved but no LLM call is made and no summary note is created.",
					control: { type: "toggle", key: "generateSummary" },
				},
				{
					name: "Summary provider",
					desc: "Which LLM provider generates the structured summary from the transcript.",
					visible: () => this.plugin.settings.generateSummary,
					control: {
						type: "dropdown",
						key: "summaryProvider",
						options: Object.fromEntries(SUMMARY_PROVIDER_ORDER.map((id) => [id, SUMMARY_PROVIDER_SCHEMA[id].label])),
					},
				},
				...this.buildSummaryProviderFields("openai"),
				...this.buildSummaryProviderFields("openrouter"),
				...this.buildSummaryProviderFields("gemini"),
				{
					name: "Summary prompt",
					desc: "Instructions sent to the LLM to turn a transcript into a structured summary (Overview, Topics Discussed, Decisions Made, Action Items, Open Questions). Customize the wording, but keep it from inventing names/owners/dates not present in the transcript.",
					visible: () => this.plugin.settings.generateSummary,
					render: (setting) => {
						this.summaryPromptTextArea = undefined; // Clear stale reference before creating new one
						setting.setClass("ai-transcribe-summary-prompt-setting");
						setting.addTextArea((text) => {
							this.summaryPromptTextArea = text;
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
						return () => {
							this.summaryPromptTextArea = undefined;
						};
					},
				},
				{
					name: "",
					visible: () => this.plugin.settings.generateSummary,
					render: (setting) => {
						setting.setClass("ai-transcribe-summary-prompt-reset");
						setting.addButton((button) =>
							button
								.setIcon("rotate-ccw")
								.setButtonText("Reset to default prompt")
								.onClick(async () => {
									this.plugin.settings.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
									await this.plugin.saveSettings();
									this.summaryPromptTextArea?.setValue(DEFAULT_SUMMARY_PROMPT);
								})
						);
					},
				},
				{
					name: "Clean up transcript",
					desc: "Run the transcript through the summary provider/model configured above to remove filler words, false starts, and grammar mistakes before it's saved or summarized. Adds one extra LLM call per recording.",
					control: { type: "toggle", key: "cleanupTranscript" },
				},
				{
					name: "Cleanup prompt",
					desc: "Instructions sent to the LLM to clean up the raw transcript. Customize the wording, but keep it from summarizing, shortening, or inventing content.",
					visible: () => this.plugin.settings.cleanupTranscript,
					render: (setting) => {
						this.cleanupPromptTextArea = undefined; // Clear stale reference before creating new one
						setting.setClass("ai-transcribe-summary-prompt-setting");
						setting.addTextArea((text) => {
							this.cleanupPromptTextArea = text;
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
						return () => {
							this.cleanupPromptTextArea = undefined;
						};
					},
				},
				{
					name: "",
					visible: () => this.plugin.settings.cleanupTranscript,
					render: (setting) => {
						setting.setClass("ai-transcribe-summary-prompt-reset");
						setting.addButton((button) =>
							button
								.setIcon("rotate-ccw")
								.setButtonText("Reset to default prompt")
								.onClick(async () => {
									this.plugin.settings.cleanupPrompt = DEFAULT_CLEANUP_PROMPT;
									await this.plugin.saveSettings();
									this.cleanupPromptTextArea?.setValue(DEFAULT_CLEANUP_PROMPT);
								})
						);
					},
				},
				{
					name: "Summary folder",
					desc: "Where the summary is written when there's no active note to insert it into at the cursor - nothing open, or a right-click 'Transcribe & summarize' retry run without a note focused (the new note uses the audio filename). If transcript placement above is 'Same note', the transcript follows the summary into this new note too. Not used when summary generation is off - the transcript then always goes to the transcript folder below instead.",
					control: {
						type: "folder",
						key: "summaryFolder",
						placeholder: DEFAULT_SETTINGS.summaryFolder,
						includeRoot: true,
					},
				},
			],
		};
	}

	private buildSummaryProviderFields(providerId: SummaryProviderId): SettingGroupItem[] {
		const schema = SUMMARY_PROVIDER_SCHEMA[providerId];
		const reuseHostLabel = PROVIDER_SETTINGS_SCHEMA[transcriptionKeyReuseTarget(this.plugin.settings)].label;
		const groupVisible = () => this.plugin.settings.generateSummary && this.plugin.settings.summaryProvider === providerId;

		return [
			{
				name: `Reuse transcription (${reuseHostLabel}) API key`,
				desc: `Transcription is currently configured to call ${reuseHostLabel} - reuse that same key for summary generation instead of a separate key here.`,
				// Gemini isn't a transcription provider, so reuse never applies to it.
				visible: () => providerId !== "gemini" && groupVisible() && transcriptionKeyReuseTarget(this.plugin.settings) === providerId,
				// Provider-qualified key: only one of these is ever visible at a time, but all three
				// share the same underlying `reuseWhisperKeyForSummary` setting (see get/setControlValue).
				control: { type: "toggle", key: `reuseWhisperKeyForSummary.${providerId}` },
			},
			{
				name: `${schema.label} API key`,
				desc: schema.description,
				visible: () =>
					groupVisible() &&
					(transcriptionKeyReuseTarget(this.plugin.settings) !== providerId || !this.plugin.settings.reuseWhisperKeyForSummary),
				render: (setting) => {
					setting.addText((text) =>
						makeSecret(text)
							.setPlaceholder(schema.apiKeyPlaceholder)
							.setValue(this.plugin.settings.summaryProviders[providerId].apiKey)
							.onChange(async (value) => {
								this.plugin.settings.summaryProviders[providerId].apiKey = value;
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: `${schema.label} model`,
				desc: schema.modelDesc,
				visible: groupVisible,
				control: {
					type: "text",
					key: `summaryProviders.${providerId}.model`,
					placeholder: schema.modelPlaceholder,
				},
			},
			{
				name: `${schema.label} temperature`,
				desc: `Randomness of the generated summary, from 0 (deterministic, sticks close to the transcript) to 2 (more creative, more prone to inventing details). Default ${DEFAULT_SUMMARY_TEMPERATURE} favors accuracy.`,
				visible: groupVisible,
				control: {
					type: "number",
					key: `summaryProviders.${providerId}.temperature`,
					placeholder: String(DEFAULT_SUMMARY_TEMPERATURE),
					min: 0,
					max: 2,
					step: "any",
					validate: (value) => (Number.isFinite(value) && value >= 0 && value <= 2 ? undefined : "Must be between 0 and 2."),
				},
			},
			{
				name: `${schema.label} base URL`,
				desc: "Edit directly to point at a proxy or self-hosted endpoint.",
				visible: groupVisible,
				control: {
					type: "text",
					key: `summaryProviders.${providerId}.baseUrl`,
					placeholder: providerId === "openai" ? OPENAI_BASE_URL : providerId === "openrouter" ? OPENROUTER_BASE_URL : GEMINI_BASE_URL,
				},
			},
		];
	}

	private buildVocabularyGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Custom vocabulary",
			items: [
				{
					name: "Vocabulary hints",
					desc: "Comma-separated names, jargon, or project terms to reduce misrecognition of recurring vocabulary. Passed to the transcription provider where supported.",
					render: (setting) => {
						setting.addTextArea((text) => {
							text
								.setPlaceholder("Obsidian, Whisper, sprint retro")
								.setValue(this.plugin.settings.vocabularyHints)
								.onChange(async (value) => {
									this.plugin.settings.vocabularyHints = value;
									await this.plugin.saveSettings();
								});
							text.inputEl.rows = 3;
						});
					},
				},
			],
		};
	}

	private buildRecordingBehaviorGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Recording",
			items: [
				{
					name: "Microphone",
					desc: "Input device used when recording. Falls back to the system default if the saved device is unavailable.",
					render: (setting) => {
						setting.addDropdown((dd) => {
							this.microphoneDropdown = dd;
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
									await this.populateMicrophoneOptions(this.microphoneDropdown, { requestPermission: true });
								})
						);

						// Without permission most platforms return zero audioinput entries, so request it up front.
						void this.populateMicrophoneOptions(this.microphoneDropdown, { requestPermission: true, silent: true });

						return () => {
							this.microphoneDropdown = undefined;
						};
					},
				},
				{
					name: "Audio bitrate",
					desc: "Recording quality vs. file size. Lower bitrates keep recordings under Whisper's 25MB ceiling for longer before chunking kicks in.",
					control: {
						type: "dropdown",
						key: "audioBitrateKbps",
						options: Object.fromEntries(AUDIO_BITRATE_OPTIONS.map((option) => [String(option.value), option.label])),
					},
				},
				{
					name: "Save audio file",
					desc: "Always preserve the recorded audio to the vault, regardless of whether transcription or summarization succeeds. Recommended to leave on - it's the only guaranteed record if a downstream step fails.",
					control: { type: "toggle", key: "saveAudioFile" },
				},
				{
					name: "Audio folder",
					desc: "Vault folder audio recordings are saved to.",
					visible: () => this.plugin.settings.saveAudioFile,
					control: {
						type: "folder",
						key: "audioFolder",
						placeholder: DEFAULT_SETTINGS.audioFolder,
						includeRoot: true,
					},
				},
				{
					name: "Silence auto-stop (minutes)",
					desc: "Recording auto-stops after this many minutes of near-silence.",
					control: {
						type: "number",
						key: "silenceAutoStopMinutes",
						placeholder: "5",
						min: 0,
						validate: (value) => (Number.isFinite(value) && value > 0 ? undefined : "Must be greater than 0."),
					},
				},
				{
					name: "Max recording duration (hours)",
					desc: "Hard backstop: recording always stops after this many hours, regardless of silence detection.",
					control: {
						type: "number",
						key: "maxRecordingHours",
						placeholder: "3",
						min: 0,
						validate: (value) => (Number.isFinite(value) && value > 0 ? undefined : "Must be greater than 0."),
					},
				},
			],
		};
	}

	private buildInterfaceGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Interface",
			items: [
				{
					name: "Confirm before starting (command/hotkey)",
					desc: 'Ask for confirmation before starting a recording via the command palette or a hotkey, to guard against an accidental press. The ribbon icon always confirms separately, since dragging it to reorder can register as a click.',
					control: { type: "toggle", key: "confirmBeforeStartingRecording" },
				},
				{
					name: "Confirm before stopping (command/hotkey)",
					desc: 'Ask for confirmation before stopping an in-progress recording via the command palette or a hotkey, to guard against an accidental press. The ribbon icon always confirms separately, since dragging it to reorder can register as a click.',
					control: { type: "toggle", key: "confirmBeforeStoppingRecording" },
				},
			],
		};
	}

	private buildSupportGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Support",
			items: [
				{
					name: "Enjoying this plugin?",
					desc: createFragment((el) => {
						el.appendText("If it's saved you time, consider supporting development on ");
						el.createEl("a", { text: "Ko-fi", href: "https://ko-fi.com/onlyutkarsh" });
						el.appendText(".");
					}),
				},
			],
		};
	}

	/** Device labels are only populated once mic permission is granted, so a refresh button re-requests access and re-enumerates. */
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

}
