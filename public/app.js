'use strict';

/* Nova frontend — vanilla JS.
 *
 * Flow (user clicks Start only; no auto-mic):
 *   1. GET /api/token (short-lived Gemini ephemeral token, minted by Node backend)
 *   2. WebSocket direct to Gemini Live:
 *      wss://generativelanguage.googleapis.com/ws/...BidiGenerateContentConstrained?access_token=TOKEN
 *   3. Send { setup } as the FIRST message (model, AUDIO modality, transcriptions,
 *      voice Puck, system instruction, session resumption). Must match the token's
 *      liveConnectConstraints locked on the backend.
 *   4. Stream mic PCM 16kHz via AudioWorklet -> { realtimeInput: { audio } }
 *   5. Play Gemini's 24 kHz PCM reply through ONE AudioContext with a scheduled queue.
 *   6. Render input/output transcriptions; handle interruption; clean Stop.
 */

// ---- Constants (must match server.js) ----
const MODEL = 'gemini-3.8-live';
const WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const SYSTEM_INSTRUCTION =
  'You are Nova, a friendly, intelligent real-time voice assistant.\n\n' +
  'Speak naturally and conversationally.\n\n' +
  'Keep normal responses concise.\n\n' +
  'Do not unnecessarily repeat information.\n\n' +
  'If the user interrupts you, stop your current response and listen.\n\n' +
  'Do not claim that you performed an action unless the action actually happened.\n\n' +
  'Be helpful, polite, and clear.';

// Gemini audio formats.
const INPUT_SAMPLE_RATE = 16000; // mic -> Gemini
const OUTPUT_SAMPLE_RATE = 24000; // Gemini -> speakers

// ---- State ----
const state = {
  status: 'idle', // idle|connecting|listening|thinking|speaking|error
  ws: null,
  micStream: null,
  micContext: null,
  micSource: null,
  workletNode: null,
  playContext: null, // single AudioContext for ALL Gemini audio (24 kHz)
  playQueue: [], // AudioBuffers waiting to play
  playCursor: 0, // next scheduled start time
  playingSources: new Set(),
  currentUserEl: null, // streaming user bubble being updated
  currentNovaEl: null, // streaming Nova bubble being updated
  sessionHandle: null, // for session resumption
  voice: 'Puck',
  micDeviceId: '',
  outputDeviceId: '',
  setupDone: false,
};

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const els = {};
window.addEventListener('DOMContentLoaded', () => {
  Object.assign(els, {
    orb: $('orb'),
    soundWave: $('soundWave'),
    statusText: $('statusText'),
    statusDot: $('statusDot'),
    micBtn: $('micBtn'),
    micBtnLabel: $('micBtnLabel'),
    clearBtn: $('clearBtn'),
    settingsBtn: $('settingsBtn'),
    headerClearBtn: $('headerClearBtn'),
    headerSettingsBtn: $('headerSettingsBtn'),
    modalCloseIcon: $('modalCloseIcon'),
    settingsModal: $('settingsModal'),
    closeSettings: $('closeSettings'),
    voiceSelect: $('voiceSelect'),
    micSelect: $('micSelect'),
    speakerSelect: $('speakerSelect'),
    conversation: $('conversation'),
    errorBanner: $('errorBanner'),
    tabVoiceBtn: $('tabVoiceBtn'),
    tabChatBtn: $('tabChatBtn'),
    liveCaption: $('liveCaption'),
    captionText: $('captionText'),
  });

  checkCompatibility();
  setStatus('idle', 'Ready — press Start to talk');
  els.micBtn.addEventListener('click', onMicButton);
  els.clearBtn.addEventListener('click', clearConversation);
  els.settingsBtn.addEventListener('click', openSettings);
  if (els.headerClearBtn) els.headerClearBtn.addEventListener('click', clearConversation);
  if (els.headerSettingsBtn) els.headerSettingsBtn.addEventListener('click', openSettings);
  if (els.modalCloseIcon) els.modalCloseIcon.addEventListener('click', closeSettings);

  // Mobile View Switcher (Voice Orb vs Transcript)
  const main = document.querySelector('.main');
  function switchMobileView(view) {
    if (!main) return;
    main.dataset.mobileView = view;
    if (els.tabVoiceBtn) {
      els.tabVoiceBtn.classList.toggle('active', view === 'voice');
      els.tabVoiceBtn.setAttribute('aria-selected', view === 'voice' ? 'true' : 'false');
    }
    if (els.tabChatBtn) {
      els.tabChatBtn.classList.toggle('active', view === 'chat');
      els.tabChatBtn.setAttribute('aria-selected', view === 'chat' ? 'true' : 'false');
    }
  }

  if (els.tabVoiceBtn) els.tabVoiceBtn.addEventListener('click', () => switchMobileView('voice'));
  if (els.tabChatBtn) els.tabChatBtn.addEventListener('click', () => switchMobileView('chat'));
  if (els.liveCaption) els.liveCaption.addEventListener('click', () => switchMobileView('chat'));

  els.textForm = $('textForm');
  els.textInput = $('textInput');
  if (els.textForm) els.textForm.addEventListener('submit', onTextSubmit);
  els.closeSettings.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });
  els.voiceSelect.addEventListener('change', () => { state.voice = els.voiceSelect.value; });
  els.micSelect.addEventListener('change', () => { state.micDeviceId = els.micSelect.value; });
  els.speakerSelect.addEventListener('change', () => {
    state.outputDeviceId = els.speakerSelect.value;
    applyOutputDevice();
  });
  loadVoices();
});

// ---- Compatibility ----
function checkCompatibility() {
  const missing = [];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) missing.push('microphone (getUserMedia)');
  if (!window.AudioContext && !window.webkitAudioContext) missing.push('Web Audio (AudioContext)');
  if (!window.WebSocket) missing.push('WebSocket');
  // AudioWorklet is preferred; fall back message only if AudioContext exists but no worklet.
  if (missing.length) {
    showError('This browser is missing: ' + missing.join(', ') + '. Use the latest Chrome or Edge over HTTPS/localhost.');
    els.micBtn.disabled = true;
  }
  if (window.isSecureContext === false) {
    showError('Microphone requires HTTPS or localhost. This page is not in a secure context.');
  }
}

// ---- Status / orb ----
const STATUS_LABEL = {
  idle: 'Ready — press Start to talk',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Nova is speaking… (you can interrupt)',
  error: 'Something went wrong',
  disconnected: 'Disconnected',
};
function setStatus(s, text) {
  state.status = s;
  els.statusText.textContent = text || STATUS_LABEL[s] || s;
  els.orb.dataset.state = s === 'disconnected' ? 'idle' : s;
  els.statusDot.dataset.state = s;
  if (els.soundWave) els.soundWave.dataset.state = s === 'disconnected' ? 'idle' : s;
  const active = s === 'listening' || s === 'thinking' || s === 'speaking';
  els.micBtn.classList.toggle('active', active);
  els.micBtnLabel.textContent = active ? 'Stop' : 'Start';
  els.micBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

// ---- Errors ----
function showError(msg) {
  els.errorBanner.textContent = msg;
  els.errorBanner.hidden = false;
  setStatus('error', msg);
}
function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
}

// ---- Start / Stop ----
async function onMicButton() {
  const active = state.ws || state.micStream;
  if (active) await stopSession();
  else await startSession();
}

async function startSession() {
  clearError();
  setStatus('connecting', STATUS_LABEL.connecting);
  try {
    // 1. Ephemeral token from our backend (permanent key stays on the server).
    const tokenRes = await fetch('/api/token');
    if (!tokenRes.ok) {
      const body = await tokenRes.json().catch(() => ({}));
      throw new Error(body.error || `Token request failed (HTTP ${tokenRes.status}). Is the server API key set?`);
    }
    const { token } = await tokenRes.json();
    if (!token) throw new Error('Server did not return a token.');

    // 2. Mic permission — ONLY after the user clicked Start.
    await startMicrophone();

    // 3. Single playback context (created on user gesture so autoplay policy passes).
    ensurePlayContext();

    // 4. Gemini Live WebSocket directly from the browser (no audio proxying).
    await connectLive(token);

    setStatus('listening', STATUS_LABEL.listening);
  } catch (err) {
    await cleanupAudioOnly();
    handleStartError(err);
  }
}

function handleStartError(err) {
  console.error(err);
  const msg = err && err.message ? err.message : String(err);
  if (err && (err.name === 'NotAllowedError' || /permission|denied/i.test(msg))) {
    showError('Microphone permission denied. Allow microphone access in the browser and try again.');
  } else if (err && (err.name === 'NotFoundError' || /no microphone|device/i.test(msg))) {
    showError('No microphone found. Connect a microphone and try again.');
  } else if (/Token request failed|Server did not return a token|Server is not configured/i.test(msg)) {
    showError(msg + ' Get a key at https://aistudio.google.com/apikey and put it in voice-agent/.env on the server.');
  } else {
    showError('Could not start: ' + msg);
  }
}

async function stopSession() {
  // 1. Tell Gemini the audio stream ended (best effort).
  try {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }
  } catch { /* ignore */ }
  // 2. Close WebSocket.
  try { if (state.ws) state.ws.close(1000, 'user stop'); } catch { /* ignore */ }
  state.ws = null;
  state.setupDone = false;
  // 3. Stop mic + worklet.
  await cleanupAudioOnly();
  // 4. Clear queued playback, stop current audio.
  stopPlayback(true);
  // 5. Finalize any streaming bubbles.
  state.currentUserEl = null;
  state.currentNovaEl = null;
  setStatus('idle', 'Ready — press Start to talk');
}

// ---- Text fallback (bypasses mic; tests model path) ----
function onTextSubmit(e) {
  if (e) e.preventDefault();
  const input = els.textInput;
  const text = (input && input.value || '').trim();
  if (!text) return;
  sendText(text);
  if (input) input.value = '';
}

function sendText(text) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.setupDone) {
    showError('Not connected. Press Start first, wait for Listening, then send text.');
    return;
  }
  console.log('[Nova] sending text:', text);
  appendUserTranscription(text);
  state.currentUserEl = null; // finalize so model reply gets its own bubble
  try {
    state.ws.send(JSON.stringify({ realtimeInput: { text } }));
  } catch (err) {
    showError('Could not send text: ' + (err && err.message ? err.message : err));
  }
}
// Console fallback: window.novaText('hello')
window.novaText = sendText;
window.novaStats = () => ({ audioChunksSent: state.audioChunksSent || 0, setupDone: state.setupDone, status: state.status });

// ---- Microphone (AudioWorklet -> 16 kHz Int16 PCM -> base64 -> Gemini) ----
async function startMicrophone() {
  const constraints = {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(state.micDeviceId ? { deviceId: { exact: state.micDeviceId } } : {}),
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.micStream = stream;

  const AC = window.AudioContext || window.webkitAudioContext;
  const micCtx = new AC({ latencyHint: 'interactive' });
  // Resume explicitly (autoplay policy: we are in a click handler, so this succeeds).
  if (micCtx.state === 'suspended') await micCtx.resume();
  state.micContext = micCtx;

  await micCtx.audioWorklet.addModule('audio-worklet.js');
  const source = micCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(micCtx, 'mic-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  state.micSource = source;
  state.workletNode = node;

  // Worklet posts { pcm16: ArrayBuffer } of 16 kHz Int16 mono samples.
  state.audioChunksSent = 0;
  node.port.onmessage = (e) => {
    const buf = e.data && e.data.pcm16;
    if (!buf || !state.ws || state.ws.readyState !== WebSocket.OPEN || !state.setupDone) return;
    const bytes = new Uint8Array(buf);
    if (bytes.length === 0) return;
    state.audioChunksSent++;
    if (state.audioChunksSent === 1 || state.audioChunksSent % 200 === 0) {
      console.log(`[Nova] mic audio chunk #${state.audioChunksSent}, bytes=${bytes.length}`);
    }
    const message = {
      realtimeInput: {
        audio: { data: bytesToBase64(bytes), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
      },
    };
    try { state.ws.send(JSON.stringify(message)); } catch { /* ignore transient send errors */ }
  };

  source.connect(node);
}

async function cleanupAudioOnly() {
  try { if (state.workletNode) state.workletNode.disconnect(); } catch { /* ignore */ }
  try { if (state.micSource) state.micSource.disconnect(); } catch { /* ignore */ }
  if (state.micContext) {
    try { await state.micContext.close(); } catch { /* ignore */ }
  }
  if (state.micStream) {
    try { state.micStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  }
  state.workletNode = null;
  state.micSource = null;
  state.micContext = null;
  state.micStream = null;
}

// ---- Gemini Live WebSocket ----
function connectLive(ephemeralToken) {
  return new Promise((resolve, reject) => {
    const url = `${WS_ENDPOINT}?access_token=${encodeURIComponent(ephemeralToken)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    let settled = false;
    let didOpen = false;
    let setupSent = false;
    const settleResolve = () => { if (!settled) { settled = true; resolve(); } };
    const settleReject = (e) => { if (!settled) { settled = true; reject(e); } };

    // If setup is not acknowledged quickly, fail with diagnostics
    // (distinguishes "never opened" network block vs "opened but rejected" setup/token issue).
    const openTimeout = setTimeout(() => {
      const st = ws.readyState;
      const stateName = st === 0 ? 'CONNECTING' : st === 1 ? 'OPEN' : st === 2 ? 'CLOSING' : 'CLOSED';
      settleReject(new Error(
        `Gemini setup not complete after 15s (opened=${didOpen}, setupSent=${setupSent}, wsState=${stateName}). ` +
        `Token fetch worked, so .env is OK. Check: 1) DevTools Network > WS > frames for close reason, ` +
        `2) server terminal for token errors, 3) wss://generativelanguage.googleapis.com reachable. Press Start again for a fresh token.`
      ));
    }, 15000);

    ws.onopen = () => {
      didOpen = true;
      // FIRST message must be setup. Per Live API WebSocket reference
      // (BidiGenerateContentSetup), responseModalities and speechConfig
      // MUST live inside generationConfig — NOT top-level setup.
      // Top-level setup only has: model, generationConfig, systemInstruction,
      // tools, realtimeInputConfig, sessionResumption, input/output transcription, etc.
      // Must satisfy the liveConnectConstraints locked in the ephemeral token.
      const setup = {
        setup: {
          model: `models/${MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: state.voice || 'Puck' } },
            },
          },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: state.sessionHandle ? { handle: state.sessionHandle } : {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              prefixPaddingMs: 20,
              silenceDurationMs: 500,
            },
          },
        },
      };
      ws.send(JSON.stringify(setup));
      didOpen = true;
      setupSent = true;
    };

    ws.onmessage = async (event) => {
      let raw = event.data;
      try {
        if (raw instanceof Blob) raw = await raw.text();
        else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      } catch { /* fall through with original */ }
      let msg;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw); }
      catch { return; }
      console.log('[Nova] Gemini message:', msg);
      handleServerMessage(msg);
      // Resolve once the session is live (setupComplete) so Start can finish.
      if (msg.setupComplete) {
        clearTimeout(openTimeout);
        state.setupDone = true;
        settleResolve();
      }
      // Some backends send session info without setupComplete flag edge cases:
      // also resolve on first serverContent after setup.
      if (!state.setupDone && msg.serverContent) {
        // Wait for explicit setupComplete; do nothing yet.
      }
    };

    ws.onerror = () => {
      clearTimeout(openTimeout);
      if (!state.setupDone) settleReject(new Error('WebSocket connection to Gemini failed. Check network and token.'));
      else showError('Connection error. The session may have dropped — press Stop, then Start again.');
    };

    ws.onclose = (event) => {
      clearTimeout(openTimeout);
      const wasSetup = state.setupDone;
      state.ws = null;
      state.setupDone = false;
      stopPlayback(true);
      if (!settled) {
        settleReject(new Error(`Gemini WebSocket closed before setup (code ${event.code}). ${event.reason || 'Try again.'}`));
        return;
      }
      if (wasSetup && (state.status === 'listening' || state.status === 'thinking' || state.status === 'speaking')) {
        // Unexpected drop mid-conversation (not user-initiated Stop which already reset UI).
        setStatus('idle', 'Disconnected — press Start to reconnect');
      }
    };
  });
}

// ---- Handle Gemini server messages ----
// Shapes (BidiGenerateContentServerMessage): setupComplete, serverContent
// ({ modelTurn.parts[].inlineData.data (base64 24kHz PCM), inputTranscription,
//    outputTranscription, interrupted, turnComplete }), sessionResumptionUpdate, goAway, toolCall.
function handleServerMessage(msg) {
  if (msg.setupComplete) {
    state.setupDone = true;
    setStatus('listening', STATUS_LABEL.listening);
    return;
  }
  if (msg.sessionResumptionUpdate) {
    const h = msg.sessionResumptionUpdate.newHandle;
    if (h) state.sessionHandle = h;
    return;
  }
  if (msg.goAway) {
    // Server is about to drop; UI note is enough (sessionResumption lets user restart).
    console.warn('Gemini goAway:', msg.goAway);
    return;
  }
  if (msg.toolCall) {
    // No tools configured in v1 — acknowledge by ignoring gracefully.
    console.warn('Unexpected toolCall (no tools configured).');
    return;
  }
  const sc = msg.serverContent;
  if (!sc) return;

  // Interruption (barge-in): Gemini stopped; drop everything queued so we listen immediately.
  if (sc.interrupted) {
    stopPlayback(true);
    state.currentNovaEl = null;
    state.currentUserEl = null;
    setStatus('listening', STATUS_LABEL.listening);
    return;
  }

  // User (input) transcription — update ONE bubble as chunks stream in.
  if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
    appendUserTranscription(sc.inputTranscription.text);
    if (state.status !== 'speaking') setStatus('thinking', STATUS_LABEL.thinking);
  }

  // Nova (output) transcription — update ONE bubble as chunks stream in.
  if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
    appendNovaTranscription(sc.outputTranscription.text);
  }

  // Model audio: base64 16-bit PCM mono @ 24 kHz inside modelTurn.parts[].inlineData.
  const parts = sc.modelTurn && sc.modelTurn.parts;
  if (parts && parts.length) {
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        enqueueModelAudio(part.inlineData.data);
      }
    }
  }

  if (sc.turnComplete) {
    // Turn finished: finalize streaming bubbles so the NEXT turn creates new ones.
    state.currentUserEl = null;
    state.currentNovaEl = null;
    if (state.ws) setStatus('listening', STATUS_LABEL.listening);
  }
}

// ---- Conversation UI (update-in-place, no duplicate bubbles per chunk) ----
function bubble(role) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'YOU' : 'NOVA';
  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = role === 'user' ? '…' : '';
  wrap.appendChild(label);
  wrap.appendChild(text);
  // Remove the "empty state" placeholder on first message.
  const empty = els.conversation.querySelector('.empty-state');
  if (empty) empty.remove();
  els.conversation.appendChild(wrap);
  els.conversation.scrollTop = els.conversation.scrollHeight;
  return text;
}

function appendUserTranscription(chunk) {
  if (!state.currentUserEl) {
    state.currentUserEl = bubble('user');
    state.currentUserEl.textContent = '';
  }
  // Gemini sends cumulative transcripts per turn; latest text replaces to avoid doubling.
  // Heuristic: if the new chunk extends the current text, replace; else append.
  const cur = state.currentUserEl.textContent;
  if (chunk.length >= cur.length && chunk.startsWith(cur.slice(0, Math.min(cur.length, 32)))) {
    state.currentUserEl.textContent = chunk;
  } else if (chunk.length < cur.length && cur.startsWith(chunk)) {
    // stale/duplicate chunk — ignore
  } else {
    state.currentUserEl.textContent = (cur ? cur + ' ' : '') + chunk;
  }
  els.conversation.scrollTop = els.conversation.scrollHeight;
  if (els.captionText && els.liveCaption) {
    els.captionText.textContent = `You: ${state.currentUserEl.textContent}`;
    els.liveCaption.hidden = false;
  }
}

function appendNovaTranscription(chunk) {
  if (!state.currentNovaEl) {
    state.currentNovaEl = bubble('nova');
    state.currentNovaEl.textContent = '';
  }
  const cur = state.currentNovaEl.textContent;
  if (chunk.length >= cur.length) {
    state.currentNovaEl.textContent = chunk;
  } else if (!(cur.startsWith(chunk))) {
    state.currentNovaEl.textContent = (cur ? cur + ' ' : '') + chunk;
  }
  els.conversation.scrollTop = els.conversation.scrollHeight;
  if (els.captionText && els.liveCaption) {
    els.captionText.textContent = `Nova: ${state.currentNovaEl.textContent}`;
    els.liveCaption.hidden = false;
  }
}

function clearConversation() {
  els.conversation.innerHTML = '<div class="empty-state"><div class="empty-icon">✦</div><div class="empty-title">Ready when you are</div><div class="empty-subtitle">Tap Start to begin speaking with Nova, or type a message below.</div></div>';
  state.currentUserEl = null;
  state.currentNovaEl = null;
  if (els.liveCaption) els.liveCaption.hidden = true;
  if (els.captionText) els.captionText.textContent = '';
}

// ---- Playback: ONE AudioContext, scheduled queue, 24 kHz PCM ----
function ensurePlayContext() {
  if (state.playContext) {
    if (state.playContext.state === 'suspended') state.playContext.resume().catch(() => {});
    return state.playContext;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  // One context for the whole session avoids gaps/clicks of per-chunk contexts.
  state.playContext = new AC({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
  state.playCursor = state.playContext.currentTime;
  applyOutputDevice();
  return state.playContext;
}

async function applyOutputDevice() {
  try {
    const ctx = state.playContext;
    if (!ctx || !state.outputDeviceId) return;
    if (typeof ctx.setSinkId === 'function') {
      await ctx.setSinkId(state.outputDeviceId);
    }
  } catch { /* output selection unsupported — ignore */ }
}

// base64 PCM (24 kHz Int16 mono) -> schedule gaplessly.
function enqueueModelAudio(b64) {
  try {
    const ctx = ensurePlayContext();
    const int16 = base64ToInt16(b64);
    if (int16.length === 0) return;
    // Convert Int16 -> Float32.
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // Gapless scheduling: chain each chunk right after the previous.
    const now = ctx.currentTime;
    if (state.playCursor < now) state.playCursor = now + 0.02;
    src.start(state.playCursor);
    state.playCursor += buffer.duration;
    state.playingSources.add(src);
    src.onended = () => state.playingSources.delete(src);
    if (state.status !== 'speaking') setStatus('speaking', STATUS_LABEL.speaking);
    // When the queue drains, go back to listening (best-effort timer).
    scheduleListeningFallback();
  } catch (e) {
    console.error('Audio playback error:', e);
  }
}

let listeningTimer = null;
function scheduleListeningFallback() {
  if (listeningTimer) clearTimeout(listeningTimer);
  listeningTimer = setTimeout(() => {
    if (!state.ws) return;
    // Only fall back if no audio is actively scheduled.
    const ctx = state.playContext;
    if (ctx && state.playCursor > ctx.currentTime + 0.1) {
      scheduleListeningFallback();
      return;
    }
    if (state.status === 'speaking') setStatus('listening', STATUS_LABEL.listening);
  }, 800);
}

// Stop current + queued audio (used on interruption and Stop).
function stopPlayback(clearQueue) {
  for (const src of state.playingSources) {
    try { src.stop(); } catch { /* already ended */ }
    try { src.disconnect(); } catch { /* ignore */ }
  }
  state.playingSources.clear();
  if (state.playContext) state.playCursor = state.playContext.currentTime;
  if (clearQueue) state.playQueue = [];
}

// ---- Settings: voices / mics / speakers ----
const KNOWN_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
function loadVoices() {
  els.voiceSelect.innerHTML = '';
  for (const v of KNOWN_VOICES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v + (v === 'Puck' ? ' (default)' : '');
    els.voiceSelect.appendChild(opt);
  }
  els.voiceSelect.value = state.voice;
}

async function openSettings() {
  els.settingsModal.hidden = false;
  await refreshDevices();
}
function closeSettings() {
  els.settingsModal.hidden = true;
}

async function refreshDevices() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const speakers = devices.filter((d) => d.kind === 'audiooutput');
    els.micSelect.innerHTML = '<option value="">Default microphone</option>';
    for (const m of mics) {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || `Microphone (${m.deviceId.slice(0, 8)}…)`;
      els.micSelect.appendChild(opt);
    }
    els.micSelect.value = state.micDeviceId;
    els.speakerSelect.innerHTML = '<option value="">Default speaker</option>';
    for (const s of speakers) {
      const opt = document.createElement('option');
      opt.value = s.deviceId;
      opt.textContent = s.label || `Speaker (${s.deviceId.slice(0, 8)}…)`;
      els.speakerSelect.appendChild(opt);
    }
    els.speakerSelect.value = state.outputDeviceId;
    // Labels are empty until mic permission is granted — hint at that.
    if (mics.length && !mics[0].label) {
      const hint = document.createElement('option');
      hint.disabled = true;
      hint.textContent = '(Start once to reveal device names)';
      els.micSelect.appendChild(hint);
    }
  } catch (e) {
    console.warn('enumerateDevices failed:', e);
  }
}

// ---- base64 helpers ----
function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToInt16(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  // PCM is little-endian Int16.
  return new Int16Array(bytes.buffer);
}
