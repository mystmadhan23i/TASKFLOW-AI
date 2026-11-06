import mongoose from 'mongoose';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, `${where}${issue.message}`, result.error.issues);
  }
  return result.data;
}

export const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);

export function requireId(v, label = 'id') {
  if (!isId(v)) throw new HttpError(400, `Invalid ${label}`);
  return v;
}

export { ZodError };
