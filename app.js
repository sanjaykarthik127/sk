require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 3000;
const MODEL = 'gemini-3.8-live';

const app = express();

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
        error: 'Server is not configured. Set GEMINI_API_KEY in environment variables.',
      });
    }

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

    return res.json({
      token: token.name,
      model: MODEL,
      newSessionExpireTime: token.newSessionExpireTime || null,
      expireTime: token.expireTime || null,
    });
  } catch (err) {
    console.error('Failed to create ephemeral token:', err && err.message ? err.message : err);
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

// Only listen when executed directly (node app.js)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nova listening on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn('WARNING: GEMINI_API_KEY is not set. GET /api/token will fail until .env is configured.');
    }
  });
}

module.exports = app;
