# htrans — Meeting Recorder

Halo canvas extension that turns a **`<title>.htrans/` folder** into a small meeting-recorder app. Click the folder in the Halo file tree to open it.

- Inputs: a microphone, optionally the **system / video sound** of a shared screen, window or tab, optionally **timed screenshots** (off / 10 s / 20 s / 30 s / 60 s) of that share.
- **Live captions** from Amazon Transcribe streaming, reached through Halo's server-side proxy (`/api/transcribe/stream`), each sentence labelled "Speaker 1", "Speaker 2", … (voices told apart, not named; needs a Halo whose proxy sends `speaker`, older ones give unlabelled lines). Nothing is transcribed in the browser and no model is downloaded.
- Everything is appended to the folder as it happens (a Halo agent can read `transcript.md` **while the meeting is still running**). A write the server doesn't take (e.g. the login expired) is kept and retried in order, with a red notice; each chunk is also kept in this browser until the server has it, and the next open of the package in the same browser writes what is left — so a reload or crash loses only the audio slice still being recorded (≤ ~5 s). See Caveats.
- Playback is never involved: the audio graph is not connected to the speakers.

## Requirements

- Halo with the `bundle` / `media` / `transcribe` extension features and the `/api/transcribe/stream` proxy.
- Microphone / screen capture needs a secure context: **https or localhost**, or the Halo desktop app (Mac / Windows).
- AWS credentials for Amazon Transcribe streaming, either
  - the server machine's default credentials (instance role, `~/.aws`, env), or
  - keys entered in **Halo Settings → Extension settings → Meeting Recorder** (`access_key_id`, `secret_access_key`, optional `session_token`; empty = default credentials).
  The identity needs `transcribe:StartStreamTranscription` and `transcribe:StartStreamTranscriptionWebSocket`.
- Settings: `region` (default `us-east-1`), `auto_languages` (default `zh-CN,zh-HK,en-US`, the candidates for the "Auto" language option).
- Language picker, in this order: Mandarin + English (default for a new meeting, and for a package that has no language recorded), Auto (Mandarin / Cantonese / English), Cantonese + English, English. A package opens with the language it recorded in `meeting.json`. The two "+ English" options are multi-language identification over that pair (the proxy gets `lang=zh-CN,en-US` / `zh-HK,en-US`; `meeting.json` keeps storing `zh-CN` / `zh-HK`, so older packages open unchanged) — English words or whole sentences inside Chinese speech come out as English. Auto identifies among all three, per stretch of speech (≥ ~1 s); Cantonese has to be an Auto candidate, otherwise it comes out as wrong Mandarin text. English = `en-US` only. Needs a Halo whose transcribe proxy accepts a comma-separated `lang` list (an older proxy answers `bad-request` for the two "+ English" options).

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
  transcript.md      "[HH:MM:SS] Speaker N: text" ("[HH:MM:SS] text" without a speaker) and "[HH:MM:SS] 📷 shots/000750.jpg", appended live
  transcript.jsonl   {"t","end","at","text","lang","speaker"?} / {"t","at","shot"}, appended live
  audio/001.webm     one opus file per recording run (chunks appended every ~5 s)
  shots/000750.jpg   screenshot, named by offset seconds
  notes.md           optional, written later by an agent
```

Offsets are `wall clock − meeting.json.startedAt`. Pause ends the current run; Resume starts a new one with a new audio file. If a tab is closed or crashes while recording, the next open marks the last run `interrupted: true` and the status `stopped`.

## How it works

`getUserMedia` (mic, echo cancellation + noise suppression) and the audio track of `getDisplayMedia` are mixed in one `AudioContext` that is never connected to `destination`. The mix feeds a `MediaRecorder` (opus/webm, 32 kbps, 5 s slices) and an `AudioWorklet` (`pcm-worklet.js`) that downsamples to 16 kHz mono s16le in ~150 ms batches; those go to the proxy WebSocket as binary frames. `partial` results are shown in grey, only `final` ones are written; a final's `speaker` ("0", "1"…, Transcribe's per-stream label) becomes `speaker: 1, 2…`, so after a pause / resume or a reconnect the same person may get a different number. The WebSocket is re-opened automatically (1 s backoff, capped at 30 s; 60 s after a credentials / permission error) and the recorder and screenshots keep running meanwhile; PCM produced while disconnected is dropped.

Screenshots (`ImageCapture.grabFrame`, or a hidden `<video>` as a fallback) are JPEG q0.8, max 1600 px wide; with "skip unchanged frames" a 32×18 grayscale thumbnail is compared with the last kept frame and near-identical frames are dropped. A thumbnail is a fixed-ratio placeholder (the screenshot's ratio once known, 16:9 before) with a soft loading shimmer until the image has decoded, and "Screenshot unavailable" if it can't be read — never the browser's broken-image icon; the enlarged view behaves the same.

Writes go out one request per chunk, in order per file. A write that fails with `io` (network error, 401, a proxy redirecting to its login page — any failure other than not-found / denied / invalid path) is not dropped: the same chunk is retried after 1 s, doubling to 30 s, and everything after it for that file waits behind it, so nothing is reordered or skipped. While any file is behind, a red notice says how many minutes are unsaved, the error, and what to do: log in to Halo again in a **new tab** (the login cookie is shared, so this page's requests start passing again) and leave this page open. When everything has been written the notice goes away and "Unsaved data written" pops up. Before an append is resent the file is stat'ed: if its size is already the last confirmed size plus this chunk, the earlier attempt landed and the chunk isn't written twice. Pause / Stop take effect at once and a new run may start meanwhile (its writes queue behind the old ones); the host's unsaved-changes guard (dirty) stays on until everything has landed. When the host marks the failure as an expired login (`auth: true` on the error frame, newer Halo) the notice says so outright; otherwise it says "most likely".

Write-ahead log: every write / append is stored in the browser's IndexedDB (database `htrans`, keyed by package path + `meeting.json` `createdAt`) before it is sent and deleted once the server confirms it; the size after each confirmed append is kept there too. Opening a package replays what an earlier page of it left unconfirmed in this browser — per file, in order, with the same size check for the first chunk, before the crash recovery below closes the run — and then says "Restored unsaved data from last time". A page holds a Web Lock (`htrans:<key>`) while it is open; a page that can't get it (the package is open in another tab or split pane) doesn't replay. Records older than 30 days are deleted.

The timeline (`transcript.md`, `transcript.jsonl`, the on-screen log) is in time order. A sentence is stamped with its start but only arrives once it is final, so a screenshot's line (the image file is written at once) waits until no earlier sentence can still come: the sentence being recognized started after it, ~2 s passed without one, or the stream closed / the run paused or stopped. Packages from 1.0.2 and earlier are shown sorted by time (files are not rewritten).

## Caveats

- Cloud transcription: the audio of the meeting is sent to AWS. The transcript is machine output and may contain errors.
- On the web, "system sound" only exists where the browser offers it (Chrome / Edge: tab or whole-screen share with "share audio"; Firefox / Safari: generally none). The desktop app answers `getDisplayMedia` with its own picker (system audio on Windows; macOS 13+ unverified).
- Amazon Transcribe closes a stream after 4 h; the extension reconnects transparently, with a short gap in the captions.
- Unsaved data (red notice) lives in this page and in this browser's storage. Reloading or closing the page while it shows is safe only in the sense that the next open of the package **in the same browser** writes it; another browser or device doesn't have it, and clearing the site data deletes it. The audio chunk the recorder was still collecting (up to ~5 s) is lost on a reload or crash. Not having to reload is still the point: log in again in a new tab.
- A page without IndexedDB or Web Locks (not a secure context — it can't record either) skips the write-ahead log or the replay; the retries still work.

MIT licensed.
