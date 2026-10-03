// Nova voice agent backend.
//
// Architecture (client-to-server, recommended by Google):
//   Browser --GET /api/token--> Node.js --auth_tokens.create--> Gemini
//   Browser --WebSocket w/ ephemeral token--> Gemini Live (audio goes direct, NOT proxied)
//
// The permanent GEMINI_API_KEY never leaves this process.

require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 3000;
const MODEL = 'gemini-3.8-live';

const SYSTEM_INSTRUCTION =
  'You are Nova, a friendly, intelligent real-time voice assistant.\n\n' +
  'Speak naturally and conversationally.\n\n' +
  'Keep normal responses concise.\n\n' +
  'Do not unnecessarily repeat information.\n\n' +
  'If the user interrupts you, stop your current response and listen.\n\n' +
  'Do not claim that you performed an action unless the action actually happened.\n\n' +
  'Be helpful, polite, and clear.';

const app = express();

// Serve the frontend.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health check (does not expose secrets).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, configured: Boolean(process.env.GEMINI_API_KEY) });
});

// Create a short-lived Gemini ephemeral token for the browser.
// The browser then connects DIRECTLY to Gemini Live over WebSocket.
app.get('/api/token', async (_req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Server is not configured. Set GEMINI_API_KEY in .env (see .env.example).',
      });
    }

    // Token creation (official @google/genai API).
    // token.name is the short-lived token value the browser must use.
    // NOTE: unconstrained token (no liveConnectConstraints), matching Google's
    // official ephemeral-tokens-websocket example. Constrained tokens silently
    // hang (OPEN but no setupComplete) on any setup mismatch, which is what
    // caused the 15s timeout. System prompt is sent by the browser setup message.
    const client = new GoogleGenAI({ apiKey });
    const now = Date.now();

    const token = await client.authTokens.create({
      config: {
        uses: 1, // single Live session per token
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      },
    });

    if (!token || !token.name) {
      throw new Error('Gemini did not return a token.');
    }

    // Return ONLY the ephemeral token — never the permanent API key.
    return res.json({
      token: token.name,
      model: MODEL,
      // Informational expiry hints for the UI (not secrets).
      newSessionExpireTime: token.newSessionExpireTime || null,
      expireTime: token.expireTime || null,
    });
  } catch (err) {
    console.error('Failed to create ephemeral token:', err && err.message ? err.message : err);
    // Do not leak API keys or stack traces to the browser.
    return res.status(500).json({
      error: 'Could not create a voice session token. Check server logs and GEMINI_API_KEY.',
    });
  }
});

// SPA fallback for unknown non-API routes.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Nova listening on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set. GET /api/token will fail until .env is configured.');
  }
});
