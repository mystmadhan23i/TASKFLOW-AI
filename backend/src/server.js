import fs from 'node:fs';
import { config, assertConfig } from './config.js';
import { connectDb } from './db.js';
import app from './app.js';

assertConfig();
fs.mkdirSync(config.uploadDir, { recursive: true });
await connectDb();

const server = app.listen(config.port, () => console.log(`TaskFlow API listening on :${config.port}`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
