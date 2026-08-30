import { App, MarkdownView, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { createSummaryProvider, createTranscriptionProvider, resolveSummaryApiKey } from "./providers/factory";
import { AiTranscribeSummarySettings, whisperKeyReuseTarget } from "./settings";

const LOG_PREFIX = "ai-transcribe-summary:";

export function logDebug(...args: unknown[]): void {
	console.debug(LOG_PREFIX, ...args);
}

export interface AudioSource {
	blob: Blob;
	mimeType: string;
	/** Base filename (no extension) used for the output note when there's no active note to insert into. */
	baseName: string;
}

/** Called with a short human-readable status as the pipeline moves through stages, so a caller can mirror it in the status bar. */
export type ProgressCallback = (status: string) => void;

/** Checks required API keys are set before any request is made, so a misconfigured provider fails immediately with a clear message instead of mid-upload. */
export function validatePipelineConfig(settings: AiTranscribeSummarySettings): string | undefined {
	if (settings.transcriptionProvider === "whisper" && !settings.providers.whisper.apiKey) {
		return 'Whisper API key is not set. Add it in Settings under "Whisper (OpenAI / OpenRouter)", or switch the transcription provider.';
	}
	if (settings.transcriptionProvider === "assemblyai" && !settings.providers.assemblyai.apiKey) {
		return 'AssemblyAI API key is not set. Add it in Settings under "AssemblyAI", or switch the transcription provider.';
	}

	if (settings.generateSummary) {
		if (settings.summaryProvider === "anthropic" || settings.summaryProvider === "google") {
			const label = settings.summaryProvider === "anthropic" ? "Anthropic" : "Google";
			return `${label} summary generation is not implemented yet. Select OpenAI or OpenRouter in Settings under "Summary generation", or turn off "Generate summary after transcription".`;
		}

		const effectiveApiKey = resolveSummaryApiKey(settings, settings.summaryProvider);
		if (!effectiveApiKey) {
			const isReusingWhisperKey = settings.reuseWhisperKeyForSummary && whisperKeyReuseTarget(settings) === settings.summaryProvider;
			const hint = isReusingWhisperKey
				? '"Reuse Whisper API key" is on but the Whisper API key is also empty - set one of the two'
				: `Add it in Settings under "Summary generation"`;
			return `Summary generation is on but the ${settings.summaryProvider} API key is not set. ${hint}, or turn off "Generate summary after transcription".`;
		}
	}

	return undefined;
}

/**
 * Runs audio -> transcript -> (optionally) summary and writes the output.
 * Shared by the live-recording stop handler and the right-click "Transcribe
 * & summarize" retry action - the only difference between the two call sites
 * is where the output lands, handled by `insertIntoActiveNote`. When
 * settings.generateSummary is off, stops after transcription: the transcript
 * is saved as its own note, no LLM call is made.
 */
export async function runTranscribeAndSummarizePipeline(
	app: App,
	settings: AiTranscribeSummarySettings,
	source: AudioSource,
	options: { insertIntoActiveNote: boolean; onProgress?: ProgressCallback }
): Promise<void> {
	const onProgress = options.onProgress ?? (() => {});

	logDebug("pipeline started", { baseName: source.baseName, mimeType: source.mimeType, sizeBytes: source.blob.size, insertIntoActiveNote: options.insertIntoActiveNote });

	const configError = validatePipelineConfig(settings);
	if (configError) {
		logDebug("config validation failed", configError);
		throw new Error(configError);
	}

	const transcriptionProvider = createTranscriptionProvider(settings);
	logDebug("transcription provider resolved", transcriptionProvider.id);

	onProgress(`Transcribing "${source.baseName}"...`);
	new Notice(`Transcribing "${source.baseName}"...`);
	const transcribeStartedAt = Date.now();
	const transcription = await transcriptionProvider.transcribe({
		audio: source.blob,
		mimeType: source.mimeType,
		vocabularyHints: settings.vocabularyHints,
		onProgress,
	});
	logDebug("transcription finished", { durationMs: Date.now() - transcribeStartedAt, textLength: transcription.text.length, repetitionWarning: transcription.repetitionWarning });

	if (transcription.repetitionWarning) {
		new Notice(`Warning: possible repetition-loop artifact detected in the transcript for "${source.baseName}".`);
	}

	if (!settings.generateSummary) {
		onProgress(`Saving transcript for "${source.baseName}"...`);
		await writeTranscriptFile(app, settings, source.baseName, buildTranscriptMarkdown(transcription.text));
		new Notice(`Transcript ready for "${source.baseName}".`);
		logDebug("pipeline finished (transcript only)");
		return;
	}

	const summaryProvider = createSummaryProvider(settings);
	logDebug("summary provider resolved", summaryProvider.id);

	onProgress(`Generating summary for "${source.baseName}"...`);
	new Notice(`Generating summary for "${source.baseName}"...`);
	const summarizeStartedAt = Date.now();
	const summaryResult = await summaryProvider.summarize({
		transcript: transcription.text,
		prompt: settings.summaryPrompt,
	});
	logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

	const summaryMarkdown = buildSummaryMarkdown(summaryResult.summary, transcription.repetitionWarning);
	const transcriptMarkdown = buildTranscriptMarkdown(transcription.text);

	const activeView = options.insertIntoActiveNote ? app.workspace.getActiveViewOfType(MarkdownView) : null;

	onProgress(`Saving results for "${source.baseName}"...`);
	if (activeView) {
		await writeIntoActiveNote(activeView, settings, summaryMarkdown, transcriptMarkdown);
	} else {
		await writeIntoNewNote(app, settings, source.baseName, summaryMarkdown, transcriptMarkdown);
	}

	new Notice(`Summary ready for "${source.baseName}".`);
	logDebug("pipeline finished (summary)");
}

function buildSummaryMarkdown(summary: string, repetitionWarning: boolean): string {
	const warning = repetitionWarning
		? "> [!warning] Possible repetition-loop artifact detected in the transcript - review before trusting this summary.\n\n"
		: "";
	return `${warning}${summary.trim()}\n`;
}

function buildTranscriptMarkdown(transcript: string): string {
	return `## Full Transcript\n\n${transcript.trim()}\n`;
}

async function writeIntoActiveNote(
	view: MarkdownView,
	settings: AiTranscribeSummarySettings,
	summaryMarkdown: string,
	transcriptMarkdown: string
): Promise<void> {
	const editor = view.editor;
	const insertion = settings.transcriptPlacement === "same-note" ? `${summaryMarkdown}\n${transcriptMarkdown}` : summaryMarkdown;
	editor.replaceSelection(insertion);

	if (settings.transcriptPlacement === "dedicated-file") {
		await writeTranscriptFile(view.app, settings, view.file?.basename ?? "meeting", transcriptMarkdown);
	}
}

async function writeIntoNewNote(
	app: App,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	summaryMarkdown: string,
	transcriptMarkdown: string
): Promise<void> {
	const folderPath = normalizePath(settings.summaryFolder);
	await ensureFolder(app, folderPath);

	const content = settings.transcriptPlacement === "same-note" ? `${summaryMarkdown}\n${transcriptMarkdown}` : summaryMarkdown;
	const notePath = normalizePath(`${folderPath}/${baseName}.md`);
	await app.vault.create(notePath, content);

	if (settings.transcriptPlacement === "dedicated-file") {
		await writeTranscriptFile(app, settings, baseName, transcriptMarkdown);
	}
}

async function writeTranscriptFile(app: App, settings: AiTranscribeSummarySettings, baseName: string, transcriptMarkdown: string): Promise<void> {
	const folderPath = normalizePath(settings.transcriptFolder);
	await ensureFolder(app, folderPath);
	const transcriptPath = normalizePath(`${folderPath}/${baseName}.md`);
	await app.vault.create(transcriptPath, transcriptMarkdown);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(folderPath);
	if (!existing) {
		await app.vault.createFolder(folderPath);
	} else if (!(existing instanceof TFolder)) {
		throw new Error(`"${folderPath}" exists but is not a folder.`);
	}
}

export function isAudioFile(file: TFile): boolean {
	return ["webm", "mp3", "wav", "m4a"].includes(file.extension.toLowerCase());
}
