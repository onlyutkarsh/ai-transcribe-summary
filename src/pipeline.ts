import { App, MarkdownView, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { createSummaryProvider, createTranscriptionProvider, resolveSummaryApiKey } from "./providers/factory";
import { AiTranscribeSummarySettings, whisperKeyReuseTarget } from "./settings";

const LOG_PREFIX = "ai-transcribe-summary:";

export function logDebug(...args: unknown[]): void {
	console.debug(LOG_PREFIX, ...args);
}

export function formatTimestampForFilename(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
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

	if (settings.generateSummary || settings.cleanupTranscript) {
		if (settings.summaryProvider === "anthropic" || settings.summaryProvider === "google") {
			const label = settings.summaryProvider === "anthropic" ? "Anthropic" : "Google";
			return `${label} summary generation is not implemented yet. Select OpenAI or OpenRouter in Settings under "Summary generation", or turn off "Generate summary after transcription"${settings.cleanupTranscript ? ' and "Clean up transcript"' : ""}.`;
		}

		const effectiveApiKey = resolveSummaryApiKey(settings, settings.summaryProvider);
		if (!effectiveApiKey) {
			const isReusingWhisperKey = settings.reuseWhisperKeyForSummary && whisperKeyReuseTarget(settings) === settings.summaryProvider;
			const hint = isReusingWhisperKey
				? '"Reuse Whisper API key" is on but the Whisper API key is also empty - set one of the two'
				: `Add it in Settings under "Summary generation"`;
			const feature = settings.generateSummary ? "Summary generation" : "Transcript cleanup";
			return `${feature} is on but the ${settings.summaryProvider} API key is not set. ${hint}, or turn off "Generate summary after transcription"${settings.cleanupTranscript ? ' / "Clean up transcript"' : ""}.`;
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

	onProgress("Transcribing");
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

	let transcriptText = transcription.text;
	if (settings.cleanupTranscript) {
		const cleanupProvider = createSummaryProvider(settings);
		logDebug("cleanup provider resolved", cleanupProvider.id);

		onProgress("Cleaning up transcript");
		new Notice(`Cleaning up transcript for "${source.baseName}"...`);
		const cleanupStartedAt = Date.now();
		const cleanupResult = await cleanupProvider.summarize({
			transcript: transcriptText,
			prompt: settings.cleanupPrompt,
		});
		logDebug("cleanup finished", { durationMs: Date.now() - cleanupStartedAt, textLength: cleanupResult.summary.length });
		transcriptText = cleanupResult.summary.trim() || transcriptText;
	}

	if (!settings.generateSummary) {
		onProgress("Saving transcript");
		await writeTranscriptFile(app, settings, source.baseName, buildTranscriptMarkdown(transcriptText));
		new Notice(`Transcript ready for "${source.baseName}".`);
		logDebug("pipeline finished (transcript only)");
		return;
	}

	const summaryProvider = createSummaryProvider(settings);
	logDebug("summary provider resolved", summaryProvider.id);

	onProgress("Generating summary");
	new Notice(`Generating summary for "${source.baseName}"...`);
	const summarizeStartedAt = Date.now();
	const summaryResult = await summaryProvider.summarize({
		transcript: transcriptText,
		prompt: settings.summaryPrompt,
	});
	logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

	const summaryMarkdown = buildSummaryMarkdown(summaryResult.summary, transcription.repetitionWarning);
	const transcriptMarkdown = buildTranscriptMarkdown(transcriptText);

	const activeView = options.insertIntoActiveNote ? app.workspace.getActiveViewOfType(MarkdownView) : null;

	onProgress("Saving results");
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
	const notePath = resolveNonCollidingPath(app, folderPath, baseName);
	await app.vault.create(notePath, content);

	if (settings.transcriptPlacement === "dedicated-file") {
		await writeTranscriptFile(app, settings, baseName, transcriptMarkdown);
	}
}

async function writeTranscriptFile(app: App, settings: AiTranscribeSummarySettings, baseName: string, transcriptMarkdown: string): Promise<void> {
	const folderPath = normalizePath(settings.transcriptFolder);
	await ensureFolder(app, folderPath);
	const transcriptPath = resolveNonCollidingPath(app, folderPath, baseName);
	await app.vault.create(transcriptPath, transcriptMarkdown);
}

/** `<folderPath>/<baseName>.md`, or the same with a timestamp appended if that path is already taken - so re-running "Transcribe & summarize" on the same audio file creates a new note instead of throwing on Vault.create(). */
function resolveNonCollidingPath(app: App, folderPath: string, baseName: string): string {
	const notePath = normalizePath(`${folderPath}/${baseName}.md`);
	if (!app.vault.getAbstractFileByPath(notePath)) {
		return notePath;
	}
	return normalizePath(`${folderPath}/${baseName} ${formatTimestampForFilename(new Date())}.md`);
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
