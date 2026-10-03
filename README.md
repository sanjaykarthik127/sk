# Nova — Real-time Voice Assistant

A beautiful, responsive browser-based voice AI assistant called **Nova**, built with Node.js + Express + vanilla HTML/CSS/JS and the **Gemini Live API**.

Open the site, press **Start**, speak naturally — Gemini replies in real time with voice, and you see live transcriptions for both sides. You can interrupt Nova while she speaks.

No Twilio. No Python. No React. No third-party voice APIs. No browser SpeechRecognition — all STT/TTS comes from Gemini Live.

## Architecture (client-to-server with ephemeral tokens)

```
Browser --GET /api/token--> Node.js + Express --auth_tokens.create--> Gemini
   |  (short-lived token only; permanent key never leaves the server)
   +--WebSocket (audio direct, NOT proxied)--> Gemini Live API
```

- Backend (`server.js`) holds `GEMINI_API_KEY` and mints an ephemeral token via `@google/genai` (`client.authTokens.create` with `liveConnectConstraints` locking `gemini-3.8-live`, AUDIO response, transcriptions, Puck voice, system prompt, session resumption).
- Browser fetches `/api/token`, then connects **directly** to:
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=TOKEN`
- First WebSocket message is `{ setup: {...} }` matching the token constraints. Mic audio (16 kHz PCM) streams as `{ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } }`. Gemini returns 24 kHz PCM in `serverContent.modelTurn.parts[].inlineData.data` plus `inputTranscription` / `outputTranscription`, `interrupted`, `turnComplete`, `sessionResumptionUpdate`.

Docs followed: https://ai.google.dev/gemini-api/docs/live-api, `/live-api/ephemeral-tokens`, `/live-api/get-started-websocket`, `/live-api/capabilities` (verified Oct 2026).

## Requirements

- Node.js 18+ (20 LTS recommended)
- A Gemini API key with Live API access: https://aistudio.google.com/apikey
- Latest Chrome or Edge (AudioWorklet + `setSinkId` support); microphone; speakers
- Secure context for mic: `http://localhost` works; any other host needs HTTPS

## Installation

```bash
cd voice-agent
npm install
```

## Configure `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```
GEMINI_API_KEY=your_key_here
PORT=3000
```

Never commit `.env` (already in `.gitignore`). Never put the permanent key in any frontend file.

## Running locally

```bash
npm start
# or, with auto-reload:
npm run dev
```

Then open http://localhost:3000

## How to test the microphone

1. Open http://localhost:3000 (allow the page to load; mic is NOT requested yet).
2. Press **Start** → browser asks for microphone permission → Allow.
3. Speak: “Hello Nova, what can you do?”
4. Watch the orb: Connecting → Listening → Thinking → Speaking.
5. `YOU` bubble shows your live transcription; `NOVA` bubble shows her reply text while she speaks through your speakers.
6. Talk over her to test interruption — queued audio stops immediately.
7. Press **Stop** — mic tracks stop, worklet disconnects, playback clears, WebSocket closes, UI returns to idle.
8. ⚙ Settings: change voice (applies next session), pick mic/speaker devices.

## File structure

```
voice-agent/
├── server.js            # Express + /api/token (ephemeral token minting)
├── package.json         # express, dotenv, @google/genai
├── .env.example         # GEMINI_API_KEY= / PORT=3000
├── .gitignore           # ignores node_modules, .env
├── README.md
└── public/
    ├── index.html       # futuristic dark UI: header, orb, conversation, mic button, settings
    ├── style.css        # glassmorphism, glowing orb states, responsive
    ├── app.js           # token fetch, Live WebSocket, mic streaming, 24kHz playback, transcripts
    └── audio-worklet.js # Float32 → resample 16kHz → Int16 PCM (no UI-thread blocking)
```

No extra files were needed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/api/token` 500 “Set GEMINI_API_KEY” | `.env` missing or server not restarted after editing. Check `GET /api/health`. |
| Mic permission denied | Allow mic in the browser site settings; use localhost/HTTPS. |
| No microphone found | Connect/enable a mic; pick it in ⚙ Settings after one Start. |
| WebSocket closed before setup / 1007 | Token expired (1-min new-session window) — press Start again for a fresh token. Offline network or blocked `wss://generativelanguage.googleapis.com`. |
| No audio out | Check speaker volume, output device in Settings, autoplay (you must click Start — that counts as the gesture). |
| Choppy mic / wrong pitch | Worklet resamples any input rate to true 16 kHz; keep chunk flow uninterrupted; close heavy tabs. |
| `model not found` | Your key/project lacks `gemini-3.8-live` access — try the key in AI Studio → Stream first. |

## Security notes

- Permanent `GEMINI_API_KEY` lives only in `server.js` via `process.env`. Frontend (`index.html`, `app.js`) never contains it — verified by grep.
- Browser gets a single-use token valid ~30 min (1 min to open the session).
- Backend returns generic errors; stack traces and keys never go to the client.

## Deployment notes

- Set env vars `GEMINI_API_KEY` (secret) and `PORT` on the host (Render/Fly/Cloud Run/VPS).
- Serve over HTTPS so `getUserMedia` works.
- `express.static("public")` serves the frontend; no build step.
- Tokens are single-use: every Start fetches a fresh one, so scaling is stateless.
- Live sessions cap ~15 min (audio-only); `sessionResumption` handle is kept client-side for reconnects.
