# voice-input — Voice Input

Halo chat-bar extension for dictation. Installing it adds a **microphone button to the chat input toolbar**. **Click it once and it starts recording; click it again to stop.** Each sentence is transcribed **on your own Halo server** and inserted into the chat box at the cursor. If text is selected, the sentence replaces the selection.

- **It never sends.** The extension can only insert text into the draft. You review it and press Send yourself.
- The small panel above the input only shows the state: a pulsing red dot with "Listening…", the elapsed time and a level meter while recording; "Recognizing…" after you stop; the download progress the first time; or the reason something went wrong, with a **Retry** button. A small Stop / Resume button in the panel is there if you want it, but you never need it.
- **Stopping never loses the last sentence.** Clicking the toolbar mic again, the panel's ×, or Esc turns the microphone off at once; the panel stays up showing "Recognizing…" until the last sentence has been inserted (usually well under a second), then closes by itself. Closing it a second time during that moment closes it immediately.
- One result per sentence: the server splits speech at pauses (VAD) and sends a sentence about 0.5 s after you stop talking. There are no live partial captions. The text comes with punctuation.
- Languages: Mandarin, English, Cantonese, Japanese and Korean, detected automatically per sentence. There is no language picker.
- Sentences are joined as you'd expect. After a sentence ending in a Chinese / Japanese character or CJK punctuation, the next one follows directly. Otherwise (English, Korean, …) one space is added in between. Each new recording starts without a leading space.
- The last two results are shown in grey. If you have more than one microphone, the panel also shows a device picker; the choice is remembered, and switching it while recording finishes the current sentence and carries on with the new device.
- Switching chat tabs or hiding the chat input closes the panel at once, and the microphone with it.
- If the browser won't let audio start without a click inside the panel (an autoplay policy, possibly Safari / iOS), the panel says so and shows a **Start recording** button instead.

## Requirements

- **Halo ≥ 1.6.5**: needs the chat-bar extension slot and the server's on-device speech-to-text (`/api/stt/stream`).
- **First use downloads about 240 MB** of model files to the server (`~/.halo/global/stt-models/`). The download starts as soon as the extension is installed. If you click the mic before it finishes, the panel shows the progress and starts listening by itself when the model is ready; anything said before that isn't recognized, so start speaking once it says "Listening…". Closing the panel meanwhile doesn't stop the download.
- Server resources: transcription uses **2–4 CPU cores** while it decodes a sentence. Once used, the engine stays **resident at about 400 MB** of RAM.
- The microphone needs a secure page: **HTTPS or localhost**, or the Halo desktop app (Mac / Windows).

## Privacy

Audio goes only to **your own Halo server**, over the same connection as the admin page. It is not sent to any cloud service and is not stored: the server keeps neither audio nor text, and never writes recognized text to its logs.

## Look and language

- The theme follows Halo. The host's `themeVars` (shadcn tokens) become `--halo-<token>` CSS variables, with built-in light / dark fallbacks.
- The language follows Halo's interface language (`init.lang`, live `lang` frames), in Chinese or English.

## Credits and licenses

The **ⓘ** button in the panel shows the same information. Its "View the license text" page shows `MODEL_LICENSE.txt` from this directory.

- **Model**: [SenseVoice-Small](https://github.com/FunAudioLLM/SenseVoice) by FunAudioLLM / Alibaba Tongyi Lab, as the int8 ONNX [sherpa-onnx conversion](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17). It is licensed under the **FunASR Model License v1.1** ([original](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE); a verbatim copy is in [`MODEL_LICENSE.txt`](MODEL_LICENSE.txt)).
- **VAD**: [Silero VAD](https://github.com/snakers4/silero-vad) (MIT).
- **Runtime**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0).
- Your Halo server downloads the model weights from Hugging Face / ModelScope. halo-hub does not distribute them, and this zip contains no model files.

## How it works

The toolbar click mounts the panel; on the host's `init` (`view: 'chatbar'`, once per iframe even though `init` is re-sent on every `ready`) recording starts. `getUserMedia` (echo cancellation and noise suppression on) feeds an `AudioContext` that is never connected to the speakers; if the context is still `suspended` after `resume()`, the panel falls back to its Start recording button. An `AnalyserNode` drives the level meter. An `AudioWorklet` (`pcm-worklet.js`, shared with htrans) converts the audio to 16 kHz mono s16le in batches of about 150 ms. Those batches go as binary frames to the WebSocket `/api/stt/stream?ext=voice-input`, which authenticates with the login cookie because the iframe is same-origin. Nothing is sent until the server says `ready`. Each `final` becomes one `insert-text` frame to the host.

Closing: from `ready` until the stream has ended, the extension reports `{type:'busy', busy:true}` to the host. A user close (toolbar button, ×, Esc) then arrives as `close-request` instead of an unmount: the extension flushes the worklet's last batch, stops the microphone, sends `{"type":"end"}`, inserts the remaining finals and reports `busy:false`, and the host unmounts the panel. Before `ready` (opening the mic, connecting, downloading) nothing is reported, so a close unmounts at once. The extension gives up waiting for the server after 30 s; the host's own limit is 35 s.

Error messages by server code: `model` means the download failed and will be retried the next time the panel is opened. `engine` means the on-device engine can't load, and the panel shows the server's message. `busy` means the server is overloaded. A denied microphone and an insecure page (no `navigator.mediaDevices`) each get their own message.

MIT licensed (code). The model has its own license, see above.
