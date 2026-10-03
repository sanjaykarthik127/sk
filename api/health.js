// Vercel serverless function: GET /api/health (no secrets exposed).
const MODEL = 'gemini-3.8-live';

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET /api/health.' });
  }
  return res.status(200).json({
    ok: true,
    model: MODEL,
    configured: Boolean(process.env.GEMINI_API_KEY),
  });
};
