import { App, Editor, MarkdownView, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { logDebug } from "./log";
import { createSummaryProvider, createTranscriptionProvider, resolveSummaryApiKey } from "./providers/factory";
import { cleanUpTranscript } from "./providers/chunked-cleanup";
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

/** True when a recording needs an actual transcription API call - either the transcript itself is wanted, or its text feeds cleanup/summary downstream. False only for a pure audio-only recording (transcript, cleanup, and summary all off), where transcription would be a wasted call. */
export function needsTranscription(settings: AiTranscribeSummarySettings): boolean {
	return settings.transcribeAudio || settings.generateSummary || settings.cleanupTranscript;
}

/** Checks required API keys are set before any request is made, so a misconfigured provider fails immediately with a clear message instead of mid-upload. */
export function validatePipelineConfig(settings: AiTranscribeSummarySettings): string | undefined {
	if (!needsTranscription(settings)) return undefined;

	const transcriptionConfig = settings.providers[settings.transcriptionProvider];
	if (!transcriptionConfig.apiKey) {
		const label = settings.transcriptionProvider === "openai" ? "OpenAI" : "OpenRouter";
		return `${label} API key is not set. Add it in Settings under "${label}", or switch the transcription provider.`;
	}

	if (settings.generateSummary || settings.cleanupTranscript) {
		const configError = validateSummaryProviderConfig(settings);
		if (configError) return configError;
	}

	return undefined;
}

/** Same summary-provider API key check as validatePipelineConfig, but standalone - used by the text-summarization pipeline (note/selection), which never touches a transcription provider. */
export function validateSummaryProviderConfig(settings: AiTranscribeSummarySettings): string | undefined {
	const effectiveApiKey = resolveSummaryApiKey(settings, settings.summaryProvider);
	if (!effectiveApiKey) {
		const isReusingTranscriptionKey = settings.reuseWhisperKeyForSummary && transcriptionKeyReuseTarget(settings) === settings.summaryProvider;
		const hint = isReusingTranscriptionKey
			? '"Reuse transcription API key" is on but the transcription API key is also empty - set one of the two'
			: `Add it in Settings under "Summary generation"`;
		return `The ${settings.summaryProvider} API key is not set. ${hint}.`;
	}
	return undefined;
}

/** A note listed first in the summary-note picker, with why it's suggested - `reason` is shown to the user. */
export interface SuggestedNote {
	file: TFile;
	reason: string;
}

/** Where a summary goes: a known note (`file` undefined meaning a new note), or ask the user, suggesting `suggested` first. */
export type SummaryTarget = { kind: "note"; file: TFile | undefined } | { kind: "ask"; suggested: SuggestedNote[] };

/**
 * Applies settings.summaryTargetNote. `startedIn` is the note open when a live recording started -
 * undefined for a right-click run on an existing audio file, which has no start, so there every
 * choice except "ask" resolves to `openNow` (the note open when it was clicked).
 */
export function resolveSummaryTarget(
	settings: Pick<AiTranscribeSummarySettings, "generateSummary" | "summaryPlacement" | "summaryTargetNote">,
	notes: { startedIn: TFile | undefined; openNow: TFile | undefined }
): SummaryTarget {
	// Asked only when a summary will actually be written into a note - otherwise the answer is unused.
	if (settings.summaryTargetNote === "ask" && settings.generateSummary && settings.summaryPlacement === "active-note") {
		const suggested: SuggestedNote[] = [];
		if (notes.startedIn) suggested.push({ file: notes.startedIn, reason: "open when recording started" });
		if (notes.openNow && notes.openNow !== notes.startedIn) suggested.push({ file: notes.openNow, reason: "open now" });
		return { kind: "ask", suggested };
	}
	// "recording-start" still falls back to the note open now when nothing was open at start -
	// e.g. the user started recording first and only then created/opened the meeting note.
	return { kind: "note", file: settings.summaryTargetNote === "recording-start" ? (notes.startedIn ?? notes.openNow) : notes.openNow };
}

/**
 * Runs audio -> transcript -> (optionally) summary and writes the output.
 * Shared by the live-recording stop handler and the right-click "Transcribe
 * & summarize" retry action; both pass the note the result belongs to via
 * `options.targetFile` (for a recording, the note open when it started), so
 * the result lands in that note even if the user has since navigated away -
 * falling back to a new note in the summary folder when it's undefined
 * (nothing was open) or has been deleted. A `TFile` rather than a
 * `MarkdownView`, since Obsidian reuses one view per tab: navigating within
 * the tab would silently retarget a held view to whatever note is now shown.
 * The caller must resolve this itself from a live-updated cache rather than
 * a workspace lookup taken at call time - opening the right-click context
 * menu moves the active leaf to the file explorer before the click handler
 * runs, so a lookup done here (e.g. `workspace.activeEditor`) would already
 * be too late even though a note is still open on screen. May be a promise
 * that's still pending (the user is still picking a note) - it's only
 * awaited right before writing, so transcription and summary run meanwhile.
 *
 * settings.transcribeAudio, settings.generateSummary, and settings.cleanupTranscript
 * are independent toggles - any combination is valid:
 * - transcribeAudio controls only whether the raw transcript is ever written anywhere
 *   (per transcriptPlacement); it does NOT gate whether transcription happens.
 * - Transcription itself runs whenever transcribeAudio, generateSummary, or
 *   cleanupTranscript is on - summary/cleanup need transcript text even when the
 *   user doesn't want the raw transcript kept. See needsTranscription().
 * - cleanupTranscript, when on, always cleans the transcript text before it's used
 *   for the kept transcript and/or the summary, regardless of the other two toggles.
 * - When both transcribeAudio and generateSummary are off, nothing downstream of
 *   transcription would ever be written, so transcription is skipped entirely and
 *   the recording is audio-only (targetFile has no effect in that case).
 */
export async function runTranscribeAndSummarizePipeline(
	app: App,
	settings: AiTranscribeSummarySettings,
	source: AudioSource,
	options: { targetFile: TFile | undefined | Promise<TFile | undefined>; onProgress?: ProgressCallback; signal?: AbortSignal }
): Promise<void> {
	const onProgress = options.onProgress ?? (() => {});
	const signal = options.signal;

	logDebug("pipeline started", {
		baseName: source.baseName,
		mimeType: source.mimeType,
		sizeBytes: source.blob.size,
		targetFile: options.targetFile instanceof Promise ? "(being picked)" : (options.targetFile?.path ?? null),
	});

	const configError = validatePipelineConfig(settings);
	if (configError) {
		logDebug("config validation failed", configError);
		throw new Error(configError);
	}

	if (!needsTranscription(settings)) {
		logDebug("pipeline finished (transcript/summary/cleanup all off, audio only)");
		new Notice(source.audioFile ? `Recording saved as "${source.baseName}" - transcription is off.` : `Recording finished - transcription is off, and "Save audio file" is also off, so nothing was kept.`);
		return;
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
		language: settings.transcriptionLanguage,
		onProgress,
		signal,
	});
	logDebug("transcription finished", { durationMs: Date.now() - transcribeStartedAt, textLength: transcription.text.length, repetitionWarning: transcription.repetitionWarning });

	if (transcription.repetitionWarning) {
		new Notice(`Warning: possible repetition-loop artifact detected in the transcript for "${source.baseName}".`);
	}

	// From here on (cleanup, summary, writing the note) a failure would otherwise discard a
	// transcript that already cost a real transcription API call to produce. Catch it, save the
	// raw transcript immediately so that cost isn't wasted, and tell the user where it landed
	// instead of just surfacing the underlying error.
	// Set once the dedicated-file transcript write below actually completes - the rescue path in
	// the catch block uses this (rather than re-deriving it from settings) so it isn't skipped
	// when a failure happens before that write runs, e.g. during cleanup.
	let dedicatedTranscriptPath: string | undefined;
	try {
		let transcriptText = transcription.text;
		if (settings.cleanupTranscript) {
			const cleanupProvider = createSummaryProvider(settings);
			logDebug("cleanup provider resolved", cleanupProvider.id);

			onProgress("Cleaning up transcript");
			new Notice(`Cleaning up transcript for "${source.baseName}"...`);
			const cleanupStartedAt = Date.now();
			transcriptText = await cleanUpTranscript(cleanupProvider, { transcript: transcriptText, prompt: settings.cleanupPrompt, signal, step: "cleanup" }, onProgress);
			logDebug("cleanup finished", { durationMs: Date.now() - cleanupStartedAt, textLength: transcriptText.length });
		}

		const transcriptMarkdown = buildTranscriptMarkdown(transcriptText);

		if (!settings.generateSummary) {
			// No summary means the transcript, if kept at all, is the sole output - always its own
			// note regardless of transcriptPlacement, which only chooses between same-note-as-summary
			// and a dedicated file when a summary exists to place it relative to.
			if (settings.transcribeAudio) {
				onProgress("Saving transcript");
				dedicatedTranscriptPath = await writeTranscriptFile(app, settings, source.baseName, transcriptMarkdown, source.audioFile);
				new Notice(`Transcript ready for "${source.baseName}".`);
			} else {
				new Notice(`Recording processed for "${source.baseName}" - transcript and summary are both off, nothing was kept.`);
			}
			logDebug("pipeline finished (transcript only, or nothing kept)");
			return;
		}

		// Written up front, independent of the summary call below - it's already fully formed and
		// paid for by the transcription request, so it shouldn't be held hostage by a summary call
		// that might fail or be cancelled. Doing this here (rather than nested in
		// writeIntoActiveNote/writeIntoNewNote) means the file appears as soon as it's ready instead
		// of only after the summary succeeds. Only when transcribeAudio is on - otherwise the raw
		// transcript is never kept, even though it was needed internally to produce the summary.
		if (settings.transcribeAudio && settings.transcriptPlacement === "dedicated-file") {
			onProgress("Saving transcript");
			dedicatedTranscriptPath = await writeTranscriptFile(app, settings, source.baseName, transcriptMarkdown, source.audioFile);
		}

		const summaryProvider = createSummaryProvider(settings);
		logDebug("summary provider resolved", summaryProvider.id);

		onProgress("Generating summary");
		new Notice(`Generating summary for "${source.baseName}"...`);
		const summarizeStartedAt = Date.now();
		const summaryResult = await summarizeLongTranscript(summaryProvider, { transcript: transcriptText, prompt: settings.summaryPrompt, signal }, onProgress);
		logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

		if (options.targetFile instanceof Promise) onProgress("Waiting for you to choose a note");
		const requestedFile = await options.targetFile;

		// Audio link travels with the summary, not the transcript - it belongs in the main note
		// (where the summary lands) even when transcript placement is "dedicated-file" and the
		// transcript itself goes to a separate file the user may not open right away. Built only
		// now because the link is relative to whichever note it's written into.
		const audioLinkMarkdown = source.audioFile ? buildAudioLinkMarkdown(app, source.audioFile, requestedFile?.path ?? "") : "";
		const summaryMarkdown = `${audioLinkMarkdown}${buildSummaryMarkdown(summaryResult.summary, transcription.repetitionWarning)}`;

		// Same-note insertion only includes the transcript when transcribeAudio is on - otherwise
		// there's nothing to append, and the summary is the whole story.
		const includeTranscriptInline = settings.transcribeAudio && settings.transcriptPlacement === "same-note";

		onProgress("Saving results");
		// Re-resolved here rather than at the start: transcription/cleanup/summary are slow async calls,
		// and the target note may have been deleted meanwhile. A rename keeps the same TFile (with an
		// updated path), so identity against the vault's current lookup covers both cases.
		const targetFile =
			settings.summaryPlacement === "active-note" && requestedFile && app.vault.getFileByPath(requestedFile.path) === requestedFile ? requestedFile : undefined;
		if (targetFile) {
			await writeIntoTargetNote(app, targetFile, summaryMarkdown, includeTranscriptInline ? transcriptMarkdown : undefined);
			new Notice(`Summary added to "${targetFile.basename}".`);
		} else {
			if (settings.summaryPlacement === "active-note" && requestedFile) {
				new Notice(`The note "${requestedFile.basename}" no longer exists - creating a new file in "${settings.summaryFolder}" instead.`);
			}
			await writeIntoNewNote(app, settings, source.baseName, summaryMarkdown, includeTranscriptInline ? transcriptMarkdown : undefined);
			new Notice(`Summary ready for "${source.baseName}".`);
		}

		logDebug("pipeline finished (summary)");
	} catch (error) {
		const cancelled = error instanceof RequestAbortedError;
		logDebug(cancelled ? "pipeline cancelled after transcription, saving raw transcript" : "pipeline failed after transcription, saving raw transcript", error);
		// If the dedicated-file transcript was already written above before the failure, it's
		// already safe - don't also write a rescue copy alongside it.
		const rescuePath = dedicatedTranscriptPath ? undefined : await tryWriteRescueTranscript(app, settings, source, transcription.text);

		if (cancelled) {
			throw new RequestAbortedError(
				rescuePath ? `Stopped. The transcript so far was saved to "${rescuePath}".` : "Stopped."
			);
		}

		// Points at "Summarize note" on the saved transcript rather than re-running "Transcribe &
		// summarize" - that would send the whole recording to the transcription API again, paying a
		// second time for a transcript that already exists.
		const message = error instanceof Error ? error.message : String(error);
		const savedTranscriptPath = rescuePath ?? dedicatedTranscriptPath;
		throw new Error(
			savedTranscriptPath
				? `${message}\n\nThe transcript was already produced and has been saved to "${savedTranscriptPath}" so it isn't lost. Once the issue above is fixed, open that note and run "Summarize note" to get the summary - re-running "Transcribe & summarize" on the audio file would transcribe it again from scratch.`
				: message,
			{ cause: error }
		);
	}
}

export interface TextSummarySource {
	/** The note/selection text to summarize. */
	text: string;
	/** Editor to write the result into - full-note commands pass the whole editor and insert at the cursor; the "Summarize selection" command passes the same editor and replaces the current selection instead. */
	editor: Editor;
	/** True to replace the current selection with the summary; false to insert at the cursor (used for whole-note summarization, where there is no meaningful selection to replace). */
	replaceSelection: boolean;
	/** Note being summarized, if any - used only for progress/error messages. */
	fileLabel: string;
}

/**
 * Summarizes arbitrary note/selection text directly - unlike
 * runTranscribeAndSummarizePipeline, there is no audio or transcription step:
 * the input text goes straight to the configured summary provider (reusing
 * the same summaryPrompt/model/map-reduce chunking as meeting summaries) and
 * the result is written back into the same editor, either replacing the
 * selection or inserted at the cursor.
 */
export async function runSummarizeTextPipeline(
	settings: AiTranscribeSummarySettings,
	source: TextSummarySource,
	options: { onProgress?: ProgressCallback; signal?: AbortSignal }
): Promise<void> {
	const onProgress = options.onProgress ?? (() => {});
	const signal = options.signal;

	logDebug("text summary pipeline started", { fileLabel: source.fileLabel, textLength: source.text.length });

	const configError = validateSummaryProviderConfig(settings);
	if (configError) {
		logDebug("config validation failed", configError);
		throw new Error(configError);
	}

	if (!source.text.trim()) {
		throw new Error("There's no text to summarize.");
	}

	const summaryProvider = createSummaryProvider(settings);
	logDebug("summary provider resolved", summaryProvider.id);

	onProgress("Generating summary");
	new Notice(`Generating summary for "${source.fileLabel}"...`);
	const summarizeStartedAt = Date.now();
	const summaryResult = await summarizeLongTranscript(summaryProvider, { transcript: source.text, prompt: settings.summaryPrompt, signal }, onProgress);
	logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

	const summaryMarkdown = buildSummaryMarkdown(summaryResult.summary, false);
	if (source.replaceSelection) {
		source.editor.replaceSelection(summaryMarkdown);
	} else {
		source.editor.replaceRange(summaryMarkdown, source.editor.getCursor());
	}

	new Notice(`Summary ready for "${source.fileLabel}".`);
	logDebug("text summary pipeline finished");
}

/** Best-effort rescue save of the raw transcript after a post-transcription failure - swallows its own errors so a failure here doesn't replace the original, more useful error with an unrelated file-write one. Named "-raw" since it's always the uncleaned transcript text, whether or not cleanup was enabled - the failure may be cleanup itself failing. */
async function tryWriteRescueTranscript(app: App, settings: AiTranscribeSummarySettings, source: AudioSource, transcriptText: string): Promise<string | undefined> {
	try {
		const folderPath = normalizePath(settings.transcriptFolder);
		await ensureFolder(app, folderPath);
		const rescuePath = resolveNonCollidingPath(app, folderPath, `${source.baseName}-raw`);
		const audioLinkMarkdown = source.audioFile ? buildAudioLinkMarkdown(app, source.audioFile, rescuePath) : "";
		await app.vault.create(rescuePath, `${audioLinkMarkdown}${buildTranscriptMarkdown(transcriptText)}`);
		logDebug("rescue transcript written", { path: rescuePath });
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

/**
 * Inserts at the cursor when the note is the one currently focused (the user is looking at it,
 * so the cursor is a deliberate position); otherwise appends to the end of the file - a cursor
 * in a background tab, or no editor at all, isn't a position the user chose.
 * `transcriptMarkdown` is undefined whenever the raw transcript shouldn't be appended -
 * transcribeAudio is off, or transcriptPlacement is "dedicated-file" (already written to its own
 * file by the caller).
 */
export async function writeIntoTargetNote(app: App, file: TFile, summaryMarkdown: string, transcriptMarkdown: string | undefined): Promise<void> {
	const insertion = transcriptMarkdown !== undefined ? `${summaryMarkdown}\n${transcriptMarkdown}` : summaryMarkdown;
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	if (activeView?.file === file) {
		// Inserted after any selection rather than replacing it - a selection left over from
		// note-taking during the meeting isn't a request to overwrite that text.
		const editor = activeView.editor;
		editor.replaceRange(insertion, editor.getCursor("to"));
		logDebug("summary inserted at cursor in target note", { path: file.path });
		return;
	}
	await app.vault.process(file, (data) => (data.trim() ? `${data.trimEnd()}\n\n${insertion}` : insertion));
	logDebug("summary appended to target note", { path: file.path });
}

async function writeIntoNewNote(app: App, settings: AiTranscribeSummarySettings, baseName: string, summaryMarkdown: string, transcriptMarkdown: string | undefined): Promise<string> {
	const folderPath = normalizePath(settings.summaryFolder);
	await ensureFolder(app, folderPath);

	const content = transcriptMarkdown !== undefined ? `${summaryMarkdown}\n${transcriptMarkdown}` : summaryMarkdown;
	const notePath = resolveNonCollidingPath(app, folderPath, `${baseName}-summary`);
	await app.vault.create(notePath, content);
	logDebug("summary written to new note", { path: notePath });
	return notePath;
}

/**
 * Writes the dedicated transcript file. When an audio file is known, prefixes
 * an embedded link to it (playable inline) - resolved against this file's own
 * path so the transcript stays self-contained and playable even when opened
 * on its own, without needing the summary note that links to it. Always
 * suffixed with "-transcript" (and the summary note with "-summary") so the
 * two never collide even when transcriptFolder and summaryFolder point at the
 * same place.
 */
async function writeTranscriptFile(
	app: App,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	transcriptMarkdown: string,
	audioFile: TFile | undefined
): Promise<string> {
	const folderPath = normalizePath(settings.transcriptFolder);
	await ensureFolder(app, folderPath);
	const transcriptPath = resolveNonCollidingPath(app, folderPath, `${baseName}-transcript`);
	const audioLinkMarkdown = audioFile ? buildAudioLinkMarkdown(app, audioFile, transcriptPath) : "";
	await app.vault.create(transcriptPath, `${audioLinkMarkdown}${transcriptMarkdown}`);
	logDebug("transcript written to new note", { path: transcriptPath });
	return transcriptPath;
}

/** `<folderPath>/<baseName>.md`, or the same with a timestamp appended if that path is already taken - so re-running "Transcribe & summarize" on the same audio file creates a new note instead of throwing on Vault.create(). */
export function resolveNonCollidingPath(app: App, folderPath: string, baseName: string): string {
	const notePath = normalizePath(`${folderPath}/${baseName}.md`);
	if (!app.vault.getAbstractFileByPath(notePath)) {
		return notePath;
	}
	return normalizePath(`${folderPath}/${baseName} ${formatTimestampForFilename(new Date())}.md`);
}

/** Same collision-avoidance as resolveNonCollidingPath, but for an arbitrary extension (used for saved audio recordings) rather than always ".md". A custom file-name template without a time component makes a same-second collision much more likely than the old fixed "meeting <timestamp>" scheme did, so this is worth having even though it wasn't needed before. */
export function resolveNonCollidingPathWithExtension(app: App, folderPath: string, baseName: string, extension: string): string {
	const filePath = normalizePath(`${folderPath}/${baseName}.${extension}`);
	if (!app.vault.getAbstractFileByPath(filePath)) {
		return filePath;
	}
	return normalizePath(`${folderPath}/${baseName} ${formatTimestampForFilename(new Date())}.${extension}`);
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
