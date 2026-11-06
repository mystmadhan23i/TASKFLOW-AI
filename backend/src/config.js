import 'dotenv/config';

const list = (v, d = '') => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/taskflow',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins: list(process.env.CORS_ORIGIN, 'http://localhost:5173'),
  appPublicUrl: (process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, ''),
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
  ai: {
    url: process.env.AI_API_URL || '',
    key: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000)
  }
};

export function assertConfig() {
  if (!config.jwtSecret || config.jwtSecret.length < 16 || config.jwtSecret.startsWith('change-me')) {
    throw new Error('JWT_SECRET must be set to a random string of at least 16 characters (see backend/.env.example).');
  }
}
