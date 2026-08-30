# AI Transcribe & Summary

An Obsidian plugin for recording meetings, transcribing them reliably, and turning the transcript into a structured summary - without losing audio to size limits, silence, or a bad API response.

Record directly in Obsidian, or right-click any existing audio file in your vault to transcribe it. Either way you get:

- The **raw audio**, always saved first, before anything else is attempted
- The **full transcript**
- A **structured summary** (Overview, Topics Discussed, Decisions Made, Action Items, Open Questions)

## Why this exists

Real meetings expose a few common failure modes in Whisper-based transcription:

- **Long recordings hit Whisper's 25MB upload limit** and fail outright, often 60-90 minutes in, with no way to recover except re-recording.
- **Silence and low-signal audio can cause repetition-loop artifacts** - the model gets stuck repeating a word or phrase - and nothing tells you it happened, so a corrupted transcript flows straight into your notes.
- **A failed transcription or summary step means you've lost the recording**, because the audio was never saved independently.
- **It's easy to forget to stop recording**, leaving long stretches of dead air to transcribe (or push you over the size limit).

This plugin is built around avoiding those failure modes specifically:

- Long recordings are automatically split at natural silence gaps and transcribed in pieces before they ever hit the size ceiling - you don't need to do anything.
- Transcripts are scanned for repetition-loop artifacts; if one is found, a warning is added to the note instead of silently trusting the output.
- The recorded audio is saved to your vault before transcription or summarization is even attempted, so a failure downstream never costs you the recording.
- Recording can auto-stop after a period of silence, with a hard maximum-duration backstop as a second line of defense.

## Features

- **In-app recording** - start, pause/resume, and stop meeting recordings from a ribbon icon, command palette, or hotkey.
- **Right-click retry** - any `.webm`, `.mp3`, `.wav`, or `.m4a` file in your vault gets a "Transcribe & summarize" context menu item, so you can (re-)process audio you already have.
- **Choice of transcription provider** - Whisper (via OpenAI or OpenRouter) by default, or AssemblyAI as an alternative with no practical file-size ceiling.
- **Choice of summary provider** - OpenAI or OpenRouter today (Anthropic and Google are planned but not yet implemented).
- **Optional transcript cleanup pass** - an LLM pass that removes filler words, false starts, and grammar mistakes before the transcript is saved or summarized, without changing its meaning.
- **Custom vocabulary hints** - feed the transcription provider a list of names, jargon, or project terms to reduce misrecognition.
- **Configurable output layout** - summary at your cursor or in a new note, transcript in the same note or a dedicated file, each in its own configurable vault folder.
- **Silence auto-stop and max-duration backstop** - stop worrying about leaving a recording running after everyone's left.

## Getting started

1. Install the plugin (see below) and enable it in Obsidian's Community Plugins settings.
2. Open **Settings → AI Transcribe & Summary** and add an API key for your chosen transcription provider (Whisper/OpenAI is the default) and summary provider.
3. Click the microphone icon in the ribbon, or run **AI Transcribe & Summary: Start recording** from the command palette.
4. When you're done, stop the recording. The audio is saved, transcribed, and summarized automatically - the summary lands at your cursor if you have a note open, or in a new note otherwise.

To process an audio file you already have in your vault, right-click it and choose **Transcribe & summarize**.

### Installation

**Manual install:**

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create a folder named `ai-transcribe-summary` inside your vault's `.obsidian/plugins/` directory and place the three files there.
3. Reload Obsidian and enable the plugin under **Settings → Community Plugins**.

**Using [BRAT](https://github.com/TfTHacker/obsidian42-brat):** add this repository (`onlyutkarsh/ai-transcribe-summary`) as a beta plugin.

## Settings overview

| Section | What it controls |
|---|---|
| Transcription provider | Whisper (OpenAI/OpenRouter) or AssemblyAI, API key, model, base URL |
| Summary generation | Summary provider, model, temperature, and the prompt used to structure the summary |
| Custom vocabulary | Names/jargon hints passed to the transcription provider |
| Recording | Microphone selection, audio bitrate, silence auto-stop, max duration, stop confirmation |
| Output | Where the raw audio, transcript, and summary are saved, and whether the transcript lives in the same note as the summary or a dedicated file |

Every prompt (summary and cleanup) is fully editable, with a one-click reset back to the default.

## Requirements

- Obsidian 1.5.0 or later.
- An API key for at least one transcription provider (OpenAI, OpenRouter, or AssemblyAI) and, if you want summaries, one summary provider.
- Works on desktop and mobile for recording and right-click retry; the live status bar timer is desktop only.

## Limitations

- Speaker diarization ("who said what") isn't supported - this uses a single mic input.
- This isn't a live/real-time transcription tool - it's record-then-process.
- Anthropic and Google summary providers are listed in settings but not yet implemented; selecting one will fail when you try to generate a summary.
- No speech-to-text system is 100% accurate. Custom vocabulary hints help with recurring names and jargon, but occasional misheard words on messy audio are expected.

## License

MIT
