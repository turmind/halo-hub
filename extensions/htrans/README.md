# htrans — Meeting Recorder

Halo canvas extension that turns a **`<title>.htrans/` folder** into a small meeting-recorder app. Click the folder in the Halo file tree to open it.

- Inputs: a microphone, optionally the **system / video sound** of a shared screen, window or tab, optionally **timed screenshots** (off / 10 s / 20 s / 30 s / 60 s) of that share.
- **Live captions** from Amazon Transcribe streaming, reached through Halo's server-side proxy (`/api/transcribe/stream`). Nothing is transcribed in the browser and no model is downloaded.
- Everything is appended to the folder as it happens, so a crash or a closed tab loses nothing, and a Halo agent can read `transcript.md` **while the meeting is still running**.
- Playback is never involved: the audio graph is not connected to the speakers.

## Requirements

- Halo with the `bundle` / `media` / `transcribe` extension features and the `/api/transcribe/stream` proxy.
- Microphone / screen capture needs a secure context: **https or localhost**, or the Halo desktop app (Mac / Windows).
- AWS credentials for Amazon Transcribe streaming, either
  - the server machine's default credentials (instance role, `~/.aws`, env), or
  - keys entered in **Halo Settings → Extension settings → Meeting Recorder** (`access_key_id`, `secret_access_key`, optional `session_token`; empty = default credentials).
  The identity needs `transcribe:StartStreamTranscription` and `transcribe:StartStreamTranscriptionWebSocket`.
- Settings: `region` (default `us-east-1`), `auto_languages` (default `zh-CN,zh-HK,en-US`, the candidates for the "Auto" language option).
- Language picker: Auto (Mandarin / Cantonese / English, default), Mandarin + English, Cantonese + English, English. The two "+ English" options are multi-language identification over that pair (the proxy gets `lang=zh-CN,en-US` / `zh-HK,en-US`; `meeting.json` keeps storing `zh-CN` / `zh-HK`, so older packages open unchanged) — English words or whole sentences inside Chinese speech come out as English. Auto identifies among all three, per stretch of speech (≥ ~1 s); Cantonese has to be an Auto candidate, otherwise it comes out as wrong Mandarin text. English = `en-US` only. Needs a Halo whose transcribe proxy accepts a comma-separated `lang` list (an older proxy answers `bad-request` for the two "+ English" options).

## Look, language and capabilities

- **Theme**: follows the host. The `init` / `theme` frames' `themeVars` (Halo's 16 theme tokens: `background`, `foreground`, `card`, `border`, `primary`, `destructive`, `ring`, …) become `--halo-<token>` CSS variables that the whole palette is derived from, so any Halo theme works without changing the extension; `theme` (`light` / `dark`, the host's brightness verdict) only picks the status green / amber.
- **Language**: follows the host's `init.lang` and live `lang` frames (zh / en) — a running recording and the current selections are kept.
- **Capabilities**: detected up front, no permission prompt. "System / video sound" is hidden where the engine can't capture a share's audio (`getDisplayMedia` plus the `suppressLocalAudioPlayback` constraint: desktop Chrome / Edge 109+ and the Halo desktop app have it; Firefox, Safari and mobile don't); "Screenshots" is hidden where there's no `getDisplayMedia` or the iframe isn't allowed `display-capture`. A short grey line says why. `window.__htransCaps` / `<html data-cap-sys data-cap-shot>` expose the result.
- **Older Halo hosts** (no `themeVars`, no `lang` frame): the built-in dark / light palette is used and the language stays as set at open.

## Package layout (written only by this extension)

```
<title>.htrans/
  meeting.json       status (idle|recording|stopped), startedAt, runs[] {startedAt, endedAt, audio, sources, interrupted?}, shotIntervalSec, asr
  README.md          agent-facing explanation (bilingual)
  transcript.md      "[HH:MM:SS] text" and "[HH:MM:SS] 📷 shots/000750.jpg", appended live
  transcript.jsonl   {"t","end","at","text","lang"} / {"t","at","shot"}, appended live
  audio/001.webm     one opus file per recording run (chunks appended every ~5 s)
  shots/000750.jpg   screenshot, named by offset seconds
  notes.md           optional, written later by an agent
```

Offsets are `wall clock − meeting.json.startedAt`. Pause ends the current run; Resume starts a new one with a new audio file. If a tab is closed or crashes while recording, the next open marks the last run `interrupted: true` and the status `stopped`.

## How it works

`getUserMedia` (mic, echo cancellation + noise suppression) and the audio track of `getDisplayMedia` are mixed in one `AudioContext` that is never connected to `destination`. The mix feeds a `MediaRecorder` (opus/webm, 32 kbps, 5 s slices) and an `AudioWorklet` (`pcm-worklet.js`) that downsamples to 16 kHz mono s16le in ~150 ms batches; those go to the proxy WebSocket as binary frames. `partial` results are shown in grey, only `final` ones are written. The WebSocket is re-opened automatically (1 s backoff, capped at 30 s; 60 s after a credentials / permission error) and the recorder and screenshots keep running meanwhile; PCM produced while disconnected is dropped.

Screenshots (`ImageCapture.grabFrame`, or a hidden `<video>` as a fallback) are JPEG q0.8, max 1600 px wide; with "skip unchanged frames" a 32×18 grayscale thumbnail is compared with the last kept frame and near-identical frames are dropped. A thumbnail is a fixed-ratio placeholder (the screenshot's ratio once known, 16:9 before) with a soft loading shimmer until the image has decoded, and "Screenshot unavailable" if it can't be read — never the browser's broken-image icon; the enlarged view behaves the same.

The timeline (`transcript.md`, `transcript.jsonl`, the on-screen log) is in time order. A sentence is stamped with its start but only arrives once it is final, so a screenshot's line (the image file is written at once) waits until no earlier sentence can still come: the sentence being recognized started after it, ~2 s passed without one, or the stream closed / the run paused or stopped. Packages from 1.0.2 and earlier are shown sorted by time (files are not rewritten).

## Caveats

- Cloud transcription: the audio of the meeting is sent to AWS. The transcript is machine output and may contain errors.
- On the web, "system sound" only exists where the browser offers it (Chrome / Edge: tab or whole-screen share with "share audio"; Firefox / Safari: generally none). The desktop app answers `getDisplayMedia` with its own picker (system audio on Windows; macOS 13+ unverified).
- Amazon Transcribe closes a stream after 4 h; the extension reconnects transparently, with a short gap in the captions.

MIT licensed.
