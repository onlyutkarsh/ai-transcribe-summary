import { App, MarkdownView, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { logDebug } from "./log";
import { createSummaryProvider, createTranscriptionProvider, resolveSummaryApiKey } from "./providers/factory";
import { summarizeLongTranscript } from "./providers/map-reduce-summarizer";
import { RequestAbortedError } from "./providers/request-timeout";
import { AiTranscribeSummarySettings, transcriptionKeyReuseTarget } from "./settings";

export { RequestAbortedError };

export { logDebug };

export function formatTimestampForFilename(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export interface AudioSource {
	blob: Blob;
	mimeType: string;
	/** Base filename (no extension) used for the output note when there's no active note to insert into. */
	baseName: string;
	/** The saved/source audio file in the vault, when one exists - used to insert a link to it alongside the transcript. Undefined when saveAudioFile is off (live recording) or never applicable. */
	audioFile?: TFile;
}

/** Called with a short human-readable status as the pipeline moves through stages, so a caller can mirror it in the status bar. */
export type ProgressCallback = (status: string) => void;

/** Checks required API keys are set before any request is made, so a misconfigured provider fails immediately with a clear message instead of mid-upload. */
export function validatePipelineConfig(settings: AiTranscribeSummarySettings): string | undefined {
	const transcriptionConfig = settings.providers[settings.transcriptionProvider];
	if (!transcriptionConfig.apiKey) {
		const label = settings.transcriptionProvider === "openai" ? "OpenAI" : "OpenRouter";
		return `${label} API key is not set. Add it in Settings under "${label}", or switch the transcription provider.`;
	}

	if (settings.generateSummary || settings.cleanupTranscript) {
		const effectiveApiKey = resolveSummaryApiKey(settings, settings.summaryProvider);
		if (!effectiveApiKey) {
			const isReusingTranscriptionKey = settings.reuseWhisperKeyForSummary && transcriptionKeyReuseTarget(settings) === settings.summaryProvider;
			const hint = isReusingTranscriptionKey
				? '"Reuse transcription API key" is on but the transcription API key is also empty - set one of the two'
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
 * & summarize" retry action; both pass the markdown note the user was last
 * editing (if any) via `options.targetView`, so the result lands at the
 * cursor there, falling back to a new note in the summary folder when
 * `targetView` is undefined (nothing was ever open). The caller must resolve
 * this itself from a live-updated cache rather than a workspace lookup taken
 * at call time - opening the right-click context menu moves the active leaf
 * to the file explorer before the click handler runs, so a lookup done here
 * (e.g. `workspace.activeEditor`/`getActiveViewOfType`) would already be too
 * late even though a note is still open on screen. When settings.generateSummary
 * is off, stops after transcription: the transcript is always saved as its own
 * note in the transcript folder, no LLM call is made, and targetView has no effect.
 */
export async function runTranscribeAndSummarizePipeline(
	app: App,
	settings: AiTranscribeSummarySettings,
	source: AudioSource,
	options: { targetView: MarkdownView | undefined; onProgress?: ProgressCallback; signal?: AbortSignal }
): Promise<void> {
	const onProgress = options.onProgress ?? (() => {});
	const signal = options.signal;

	logDebug("pipeline started", {
		baseName: source.baseName,
		mimeType: source.mimeType,
		sizeBytes: source.blob.size,
		targetViewFile: options.targetView?.file?.path ?? null,
	});

	const configError = validatePipelineConfig(settings);
	if (configError) {
		logDebug("config validation failed", configError);
		throw new Error(configError);
	}

	// Captured up front, not after the transcription/summary calls - the user may switch notes
	// while those are in flight, and the result should land in the note that was active when
	// recording stopped, not whatever happens to be active when the LLM calls finish.
	// targetView comes from a cache in main.ts that can outlive the note it points to (closed
	// tab, deleted file) - confirm its leaf is still open before trusting it as an insert target.
	const targetLeafStillOpen = options.targetView && app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === options.targetView);
	const activeView = targetLeafStillOpen ? options.targetView : undefined;

	const transcriptionProvider = createTranscriptionProvider(settings);
	logDebug("transcription provider resolved", transcriptionProvider.id);

	onProgress("Transcribing");
	new Notice(`Transcribing "${source.baseName}"...`);
	const transcribeStartedAt = Date.now();
	const transcription = await transcriptionProvider.transcribe({
		audio: source.blob,
		mimeType: source.mimeType,
		vocabularyHints: settings.vocabularyHints,
		language: settings.transcriptionLanguage,
		onProgress,
		signal,
	});
	logDebug("transcription finished", { durationMs: Date.now() - transcribeStartedAt, textLength: transcription.text.length, repetitionWarning: transcription.repetitionWarning });

	if (transcription.repetitionWarning) {
		new Notice(`Warning: possible repetition-loop artifact detected in the transcript for "${source.baseName}".`);
	}

	const audioLinkMarkdown = source.audioFile ? buildAudioLinkMarkdown(app, source.audioFile, activeView?.file?.path ?? "") : "";

	// From here on (cleanup, summary, writing the note) a failure would otherwise discard a
	// transcript that already cost a real transcription API call to produce. Catch it, save the
	// raw transcript immediately so that cost isn't wasted, and tell the user where it landed
	// instead of just surfacing the underlying error.
	try {
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
				signal,
			});
			logDebug("cleanup finished", { durationMs: Date.now() - cleanupStartedAt, textLength: cleanupResult.summary.length });
			transcriptText = cleanupResult.summary.trim() || transcriptText;
		}

		if (!settings.generateSummary) {
			onProgress("Saving transcript");
			await writeTranscriptFile(app, settings, source.baseName, buildTranscriptMarkdown(transcriptText), source.audioFile);
			new Notice(`Transcript ready for "${source.baseName}".`);
			logDebug("pipeline finished (transcript only)");
			return;
		}

		const summaryProvider = createSummaryProvider(settings);
		logDebug("summary provider resolved", summaryProvider.id);

		onProgress("Generating summary");
		new Notice(`Generating summary for "${source.baseName}"...`);
		const summarizeStartedAt = Date.now();
		const summaryResult = await summarizeLongTranscript(summaryProvider, { transcript: transcriptText, prompt: settings.summaryPrompt, signal }, onProgress);
		logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

		// Audio link travels with the summary, not the transcript - it belongs in the main note
		// (where the summary lands) even when transcript placement is "dedicated-file" and the
		// transcript itself goes to a separate file the user may not open right away.
		const summaryMarkdown = `${audioLinkMarkdown}${buildSummaryMarkdown(summaryResult.summary, transcription.repetitionWarning)}`;
		const transcriptMarkdown = buildTranscriptMarkdown(transcriptText);

		onProgress("Saving results");
		if (activeView) {
			await writeIntoActiveNote(activeView, settings, source.baseName, summaryMarkdown, transcriptMarkdown, source.audioFile);
		} else {
			await writeIntoNewNote(app, settings, source.baseName, summaryMarkdown, transcriptMarkdown, source.audioFile);
		}

		new Notice(`Summary ready for "${source.baseName}".`);
		logDebug("pipeline finished (summary)");
	} catch (error) {
		const cancelled = error instanceof RequestAbortedError;
		logDebug(cancelled ? "pipeline cancelled after transcription, saving raw transcript" : "pipeline failed after transcription, saving raw transcript", error);
		const rescuePath = await tryWriteRescueTranscript(app, settings, source, transcription.text);

		if (cancelled) {
			throw new RequestAbortedError(
				rescuePath ? `Stopped. The transcript so far was saved to "${rescuePath}".` : "Stopped."
			);
		}

		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			rescuePath
				? `${message}\n\nThe transcript was already produced and has been saved to "${rescuePath}" so it isn't lost. Fix the issue above, then re-run "Transcribe & summarize" on the audio file - or use the saved transcript directly.`
				: message,
			{ cause: error }
		);
	}
}

/** Best-effort rescue save of the raw transcript after a post-transcription failure - swallows its own errors so a failure here doesn't replace the original, more useful error with an unrelated file-write one. */
async function tryWriteRescueTranscript(app: App, settings: AiTranscribeSummarySettings, source: AudioSource, transcriptText: string): Promise<string | undefined> {
	try {
		const folderPath = normalizePath(settings.transcriptFolder);
		await ensureFolder(app, folderPath);
		const rescuePath = resolveNonCollidingPath(app, folderPath, `${source.baseName} (rescued transcript)`);
		const audioLinkMarkdown = source.audioFile ? buildAudioLinkMarkdown(app, source.audioFile, rescuePath) : "";
		await app.vault.create(rescuePath, `${audioLinkMarkdown}${buildTranscriptMarkdown(transcriptText)}`);
		return rescuePath;
	} catch (rescueError) {
		logDebug("rescue transcript save also failed", rescueError);
		return undefined;
	}
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

/**
 * Embedded link to the saved/source audio file, placed just above the
 * transcript/summary - `!` forces an embed (renders as a playable audio
 * widget) regardless of generateMarkdownLink's own wikilink-vs-markdown
 * choice, which just follows the vault's "Use [[Wikilinks]]" setting.
 * `sourcePath` is the path of the note the link will be written into (for a
 * correctly relative link); "" when there's no active note, i.e. it's about
 * to be written into a brand-new note at the vault root of summaryFolder.
 */
function buildAudioLinkMarkdown(app: App, audioFile: TFile, sourcePath: string): string {
	const link = app.fileManager.generateMarkdownLink(audioFile, sourcePath);
	return `!${link}\n\n`;
}

async function writeIntoActiveNote(
	view: MarkdownView,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	summaryMarkdown: string,
	transcriptMarkdown: string,
	audioFile: TFile | undefined
): Promise<void> {
	const editor = view.editor;
	const insertion = settings.transcriptPlacement === "same-note" ? `${summaryMarkdown}\n${transcriptMarkdown}` : summaryMarkdown;
	editor.replaceSelection(insertion);

	if (settings.transcriptPlacement === "dedicated-file") {
		await writeTranscriptFile(view.app, settings, baseName, transcriptMarkdown, audioFile);
	}
}

async function writeIntoNewNote(
	app: App,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	summaryMarkdown: string,
	transcriptMarkdown: string,
	audioFile: TFile | undefined
): Promise<void> {
	const folderPath = normalizePath(settings.summaryFolder);
	await ensureFolder(app, folderPath);

	const content = settings.transcriptPlacement === "same-note" ? `${summaryMarkdown}\n${transcriptMarkdown}` : summaryMarkdown;
	const notePath = resolveNonCollidingPath(app, folderPath, baseName);
	await app.vault.create(notePath, content);

	if (settings.transcriptPlacement === "dedicated-file") {
		await writeTranscriptFile(app, settings, baseName, transcriptMarkdown, audioFile);
	}
}

/**
 * Writes the dedicated transcript file. When an audio file is known, prefixes
 * an embedded link to it (playable inline) - resolved against this file's own
 * path so the transcript stays self-contained and playable even when opened
 * on its own, without needing the summary note that links to it.
 */
async function writeTranscriptFile(
	app: App,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	transcriptMarkdown: string,
	audioFile: TFile | undefined
): Promise<void> {
	const folderPath = normalizePath(settings.transcriptFolder);
	await ensureFolder(app, folderPath);
	const transcriptPath = resolveNonCollidingPath(app, folderPath, baseName);
	const audioLinkMarkdown = audioFile ? buildAudioLinkMarkdown(app, audioFile, transcriptPath) : "";
	await app.vault.create(transcriptPath, `${audioLinkMarkdown}${transcriptMarkdown}`);
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
	return ["webm", "ogg", "mp3", "wav", "m4a"].includes(file.extension.toLowerCase());
}
