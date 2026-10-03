// Nova voice agent server entrypoint.
require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nova listening on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn('WARNING: GEMINI_API_KEY is not set. GET /api/token will fail until .env is configured.');
    }
  });
}

module.exports = app;
