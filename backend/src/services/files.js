import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const uploadRoot = () => path.resolve(config.uploadDir);

export const storedPath = (storedName) => path.join(uploadRoot(), path.basename(storedName));

export async function removeStoredFiles(attachments = []) {
  await Promise.all(attachments.map((a) => fs.promises.rm(storedPath(a.storedName), { force: true }).catch(() => {})));
}
