# Voice Transcription

Transcribe captured voice memos into text.

<!-- screenshot: voice settings panel -->

## Two Backends

| Backend | Where it runs | Pros | Cons |
| --- | --- | --- | --- |
| **Local Whisper** | Your machine | Private, free, offline | Larger models = larger downloads |
| **OpenAI Whisper API** | OpenAI cloud | Faster on small devices, latest models | Requires API key, content leaves your device |

Pick a backend in [Settings → AI → Voice Transcription](/user-guide/settings#ai).

## Local Whisper

Memry uses Whisper Small as the default local model — a balance of accuracy and speed.

### Setup

1. Settings → AI → Voice Transcription → Provider: **Local**
2. Click **Download** for the model
3. Wait for status: **Loaded**

Model files are stored locally in the app data directory. Disk usage is shown next to each option.

### Languages

Whisper Small handles dozens of languages well. For unusual languages, larger Whisper models tend to do better — see the open-source Whisper docs for tradeoffs.

## OpenAI Whisper API

For machines that struggle with local Whisper or when you want maximum accuracy:

1. Settings → AI → Voice Transcription → Provider: **OpenAI**
2. Paste your **API key**
3. The key is stored locally in the vault, encrypted at rest

Each transcription call counts against your OpenAI quota.

## How Voice Memos Are Captured

The [Inbox](/user-guide/inbox/capturing) supports voice capture from its header. Recorded audio is queued for transcription.

Transcribed items appear in the inbox under the **voice** content type filter. The original audio is preserved as an attachment.

## What's Sent Where

| Provider | What leaves your device |
| --- | --- |
| Local Whisper | Nothing |
| OpenAI Whisper | Audio file → OpenAI API; transcript returns |

Memry does not forward audio through the sync server.

## Transcription Quality

For clear speech in supported languages, Whisper produces near-broadcast quality transcripts. Background noise, multiple speakers, and technical jargon hurt accuracy. Editing the resulting text is normal — Memry treats the transcript as a starting point.

## Disabling

Disabling **Enable** in the AI panel halts new transcriptions. Existing inbox voice items stay; their transcripts (if any) remain.

## See Also

- [Inbox](/user-guide/inbox/capturing)
- [Provider Setup](/user-guide/ai/provider-setup)
