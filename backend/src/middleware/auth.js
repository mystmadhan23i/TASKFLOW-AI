import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import User from '../models/User.js';
import { HttpError, asyncHandler } from '../utils/http.js';

export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Authentication required');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: 'taskflow' });
  } catch {
    throw new HttpError(401, 'Session expired. Please sign in again.');
  }
  const user = await User.findById(payload.sub);
  if (!user) throw new HttpError(401, 'Account no longer exists');
  req.user = user;
  next();
});
