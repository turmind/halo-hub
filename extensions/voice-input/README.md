# voice-input — Voice Input

Halo chat-bar extension for dictation. Installing it adds a **microphone button to the chat input toolbar**. The button opens a small panel with one big record button: click it, speak, and click it again to stop. Each sentence is transcribed **on your own Halo server** and inserted into the chat box at the cursor. If text is selected, the sentence replaces the selection.

- **It never sends.** The extension can only insert text into the draft. You review it and press Send yourself.
- One result per sentence: the server splits speech at pauses (VAD) and sends a sentence about 0.5 s after you stop talking. There are no live partial captions. The text comes with punctuation.
- Languages: Mandarin, English, Cantonese, Japanese and Korean, detected automatically per sentence. There is no language picker.
- Sentences are joined as you'd expect. After a sentence ending in a Chinese / Japanese character or CJK punctuation, the next one follows directly. Otherwise (English, Korean, …) one space is added in between. Each new recording starts without a leading space.
- The panel shows a level meter, the elapsed time and the last two results in grey. If you have more than one microphone, it also shows a device picker, and the choice is remembered.
- Closing the panel (× or Esc on the page) stops the microphone.

## Requirements

- **Halo ≥ 1.6.5**: needs the chat-bar extension slot and the server's on-device speech-to-text (`/api/stt/stream`).
- **First use downloads about 240 MB** of model files to the server (`~/.halo/global/stt-models/`). The download starts as soon as the extension is installed. The panel shows its progress if you open it before it finishes. Audio recorded while the download runs is not kept, so start speaking once the panel says it's listening.
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

`getUserMedia` (echo cancellation and noise suppression on) feeds an `AudioContext` that is never connected to the speakers. An `AnalyserNode` drives the level meter. An `AudioWorklet` (`pcm-worklet.js`, shared with htrans) converts the audio to 16 kHz mono s16le in batches of about 150 ms. Those batches go as binary frames to the WebSocket `/api/stt/stream?ext=voice-input`, which authenticates with the login cookie because the iframe is same-origin. Nothing is sent until the server says `ready`. Each `final` becomes one `insert-text` frame to the host. Stop flushes the worklet's last batch, sends `{"type":"end"}`, turns the microphone off and shows "Recognizing…" until the server has sent the last sentences and closed the socket.

Error messages by server code: `model` means the download failed and will be retried the next time the panel is opened. `engine` means the on-device engine can't load, and the panel shows the server's message. `busy` means the server is overloaded. A denied microphone and an insecure page (no `navigator.mediaDevices`) each get their own message.

MIT licensed (code). The model has its own license, see above.
