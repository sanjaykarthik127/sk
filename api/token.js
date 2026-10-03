// Vercel serverless function: GET /api/token
// Mints a short-lived Gemini ephemeral token. Permanent key stays server-side.
const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-3.8-live';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET /api/token.' });
  }
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Server is not configured. Set GEMINI_API_KEY in Vercel env vars.',
      });
    }

    const client = new GoogleGenAI({ apiKey });
    const now = Date.now();

    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      },
    });

    if (!token || !token.name) {
      throw new Error('Gemini did not return a token.');
    }

    return res.status(200).json({
      token: token.name,
      model: MODEL,
      newSessionExpireTime: token.newSessionExpireTime || null,
      expireTime: token.expireTime || null,
    });
  } catch (err) {
    console.error('Failed to create ephemeral token:', (err && err.message) || err);
    return res.status(500).json({
      error: 'Could not create a voice session token. Check Vercel logs and GEMINI_API_KEY.',
    });
  }
};
