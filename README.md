# AI Transcribe and Summary

An Obsidian plugin for recording meetings, transcribing them reliably, and turning the transcript into a structured summary - without losing audio to size limits, silence, or a bad API response.

Record directly in Obsidian, or right-click any existing audio file in your vault to transcribe it. Either way you get:

- The **raw audio**, always saved first, before anything else is attempted
- The **full transcript**
- A **structured summary** (Overview, Topics Discussed, Decisions Made, Action Items, Open Questions)

## Why this exists

Real meetings expose a few common failure modes in Whisper-based transcription:

- **Long recordings hit Whisper's 25MB upload limit** and fail outright, often 60-90 minutes in, with no way to recover except re-recording.
- **Silence and low-signal audio can cause repetition-loop artifacts** - the model gets stuck repeating a word or phrase - and nothing tells you it happened, so a corrupted transcript flows straight into your notes.
- **A short, accidentally-silent recording still gets sent for transcription** - a muted mic, a dead input device, or a wrong device selection can produce a clip with no audio signal at all, and without a check it would burn an API call for nothing.
- **A failed transcription or summary step means you've lost the recording**, because the audio was never saved independently.
- **It's easy to forget to stop recording**, leaving long stretches of dead air to transcribe (or push you over the size limit).

This plugin is built around avoiding those failure modes specifically:

- Long recordings are automatically split at natural silence gaps and transcribed in pieces (in parallel, to keep total wait time down) before they ever hit the size ceiling - you don't need to do anything. If no silence gap is found near a split point (e.g. continuous speech with no pause), that piece falls back to a hard cut at the target size rather than failing.
- Very long transcripts are summarized in parts and combined, rather than sent as one oversized request - this keeps summary quality consistent and avoids failures on meetings that would otherwise be too long for a single request.
- Transcripts are scanned for repetition-loop artifacts; if one is found, a warning is added to the note instead of silently trusting the output.
- The recorded audio is saved to your vault before transcription or summarization is even attempted, so a failure downstream never costs you the recording. If cleanup or summary generation fails after transcription succeeds, the transcript itself is also saved immediately, so a slow or failed API call never costs you a re-transcription.
- Recording can auto-stop after a period of silence, with a hard maximum-duration backstop as a second line of defense.
- A finished recording or existing audio file with no detectable audio signal triggers a warning before transcription starts, rather than silently spending an API call on it - you can still choose to transcribe anyway.
- For a recording several hours long, you'll get a heads-up if splitting it for transcription might use a lot of memory on your device - the audio is already safely saved either way.

## Features

- **In-app recording** - start, pause/resume, and stop meeting recordings from a ribbon icon, command palette, or hotkey.
- **Right-click retry** - any `.webm`, `.mp3`, `.wav`, or `.m4a` file in your vault gets a "Transcribe & summarize" context menu item, so you can (re-)process audio you already have. Works from Obsidian's built-in file explorer and, if installed, the [Notebook Navigator](https://github.com/johansan/notebook-navigator) community plugin's file menu too.
- **Summarize an existing note** - turn any markdown note's text directly into a structured summary, no audio involved, via the command palette (**Summarize note**) or by right-clicking the note in the file explorer.
- **Choice of transcription provider** - Whisper via OpenAI or OpenRouter.
- **Choice of summary provider** - OpenAI, Google Gemini, or OpenRouter (OpenRouter also gives access to Anthropic and other Google models under one key).
- **Speaking language hint** - tell Whisper what language you're speaking (or leave it on auto-detect) to improve transcription accuracy and speed, especially on short or accented recordings.
- **Optional transcript cleanup pass** - an LLM pass that removes filler words, false starts, and grammar mistakes before the transcript is saved or summarized, without changing its meaning.
- **Custom vocabulary hints** - feed the transcription provider a list of names, jargon, or project terms to reduce misrecognition.
- **Configurable output layout** - summary at your cursor or in a new note, transcript in the same note or a dedicated file, each in its own configurable vault folder.
- **Silence auto-stop and max-duration backstop** - stop worrying about leaving a recording running after everyone's left.
- **Silent-recording warning** - if a recording or existing audio file has no detectable signal, you're warned before it's sent off for transcription, with the option to proceed anyway.
- **Cancel anytime** - stop an in-progress transcription or summary from the command palette; the audio you already have stays saved either way.
- **Live status bar progress** - see recording time while recording, and the current pipeline stage (e.g. "Generating summary") while processing, including when more than one job is running at once.

## Getting started

1. Install the plugin (see below) and enable it in Obsidian's Community Plugins settings.
2. Open **Settings → AI Transcribe and Summary** and add an API key for your chosen transcription provider (Whisper/OpenRouter is the default) and summary provider.
3. Click the microphone icon in the ribbon, or run **AI Transcribe and Summary: Start recording** from the command palette.
4. When you're done, stop the recording. The audio is saved and transcribed automatically; if summary generation is enabled, the summary lands at your cursor if you have a note open, or in a new note otherwise.

To process an audio file you already have in your vault, right-click it and choose **Transcribe & summarize** (or run **AI Transcribe and Summary: Transcribe & summarize active file** from the command palette if it's already open). To summarize a note's text directly, without any audio, right-click the note and choose **Summarize note**, or run **AI Transcribe and Summary: Summarize note** from the command palette with that note active.

If a job is taking too long or you started it by mistake, run **AI Transcribe and Summary: Stop transcription/summary** to cancel it - anything already saved (raw audio, or a transcript from a completed step) stays put.

### Getting an API key

You need a key for at least one transcription provider (OpenAI or OpenRouter) and, if you want summaries, one summary provider (OpenAI, OpenRouter, or Gemini). The same OpenAI or OpenRouter key can be reused for both transcription and summary generation via the "Reuse transcription API key" toggle.

**OpenAI:**

1. Go to the [OpenAI API keys page](https://platform.openai.com/api-keys) and sign in.
2. Click **Create new secret key**, name it, and copy the value (you won't be able to see it again).
3. You'll need billing set up on the account - Whisper and Chat Completions are pay-as-you-go, not covered by ChatGPT subscriptions.
4. In Obsidian, open **Settings → AI Transcribe and Summary**, pick **OpenAI** as the transcription and/or summary provider, and paste the key into the API key field.

**OpenRouter:**

1. Go to [OpenRouter's Keys page](https://openrouter.ai/keys) and sign in.
2. Click **Create Key**, name it, and copy the value.
3. Add credit to your account (OpenRouter is pay-as-you-go); some models have free tiers with tighter rate limits.
4. In Obsidian, set the transcription and/or summary provider to **OpenRouter** and paste the key in. For the model field, use a provider-prefixed model id (e.g. `openai/whisper-1`, `openai/gpt-4o-mini`) - browse ids on [OpenRouter's model page](https://openrouter.ai/models).

**Google Gemini** (summary provider only - transcription still goes through OpenAI or OpenRouter's Whisper):

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key**, and choose or create a Google Cloud project when prompted.
3. Copy the generated key.
4. In Obsidian, set the summary provider to **Google Gemini** and paste the key into the API key field.

All three providers meter usage per request; check their pricing/quota pages ([OpenAI](https://openai.com/api/pricing/), [OpenRouter](https://openrouter.ai/models), [Gemini](https://ai.google.dev/gemini-api/docs/pricing)) if you hit rate limits or unexpected charges.

### Installation

**Manual install:**

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create a folder named `ai-transcribe-summary` inside your vault's `.obsidian/plugins/` directory and place the three files there.
3. Reload Obsidian and enable the plugin under **Settings → Community Plugins**.

**Using [BRAT](https://github.com/TfTHacker/obsidian42-brat):** add this repository (`onlyutkarsh/ai-transcribe-summary`) as a beta plugin.

## Settings overview

| Section | What it controls |
|---|---|
| Transcription provider | OpenAI or OpenRouter (Whisper), API key, model, base URL, speaking language hint |
| Summary generation | Summary provider, model, temperature, the prompt used to structure the summary, and whether to reuse your transcription API key |
| Custom vocabulary | Names/jargon hints passed to the transcription provider |
| Recording | Microphone selection, audio bitrate, silence auto-stop, max duration, start/stop confirmation |
| Output | Where the raw audio, transcript, and summary are saved, and whether the transcript lives in the same note as the summary or a dedicated file |

Every prompt (summary and cleanup) is fully editable, with a one-click reset back to the default.

## Security & privacy

- **Audio and transcripts leave your device only for processing.** Recorded audio is sent to your chosen transcription provider (OpenAI or OpenRouter's Whisper endpoint) over HTTPS. If summary generation or transcript cleanup is enabled, the transcript text is sent to your chosen summary provider (OpenAI, Google Gemini, or OpenRouter) over HTTPS. No other data leaves your vault, and there is no telemetry.
- **API keys are stored locally**, in your vault's `.obsidian/plugins/ai-transcribe-summary/data.json`, alongside your other plugin settings. They're never sent anywhere except as the `Authorization` header on requests to the provider you configured. If you sync or back up your vault, treat that file like any other secret - exclude it (e.g. via `.gitignore`) if your vault is versioned or shared.
- **Retention is governed by your provider**, not this plugin. Check OpenAI's, Google's, or OpenRouter's own data-retention and training-use policies if that matters for your use case - they differ by provider and by account/API tier.
- **Get consent before recording other people.** Recording meetings, calls, or conversations without the knowledge of other participants may be illegal depending on your jurisdiction, and audio is transmitted to a third-party API once recording stops.
- **Everything else stays local.** Raw audio, transcripts, and summaries are written directly to your vault as regular files - this plugin doesn't run its own backend or store your content anywhere outside the providers you explicitly configure.

## Requirements

- Obsidian 1.5.0 or later.
- An API key for at least one transcription provider (OpenAI or OpenRouter) and, if you want summaries, one summary provider.
- Desktop only.

## Limitations

- Speaker diarization ("who said what") isn't supported - this uses a single mic input.
- This isn't a live/real-time transcription tool - it's record-then-process.
- No speech-to-text system is 100% accurate. Custom vocabulary hints help with recurring names and jargon, but occasional misheard words on messy audio are expected.

## Development

Built with the help of AI coding assistants.

## License

MIT
