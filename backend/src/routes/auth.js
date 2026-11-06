import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import User from '../models/User.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse } from '../utils/http.js';

const router = Router();

const password = z.string().min(10, 'Password must be at least 10 characters').max(128);
const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  email: z.string().trim().email('Enter a valid email').max(254),
  password
});
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) });

const issueToken = (user) => jwt.sign({ sub: user.id }, config.jwtSecret, {
  algorithm: 'HS256', expiresIn: config.jwtExpiresIn, issuer: 'taskflow'
});

router.post('/register', asyncHandler(async (req, res) => {
  const data = parse(registerSchema, req.body);
  const email = data.email.toLowerCase();
  if (await User.exists({ email })) throw new HttpError(409, 'An account with this email already exists');
  const user = await User.create({ name: data.name, email, passwordHash: await bcrypt.hash(data.password, 12) });
  res.status(201).json({ token: issueToken(user), user: user.toPublic() });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const data = parse(loginSchema, req.body);
  const user = await User.findOne({ email: data.email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid email or password');
  }
  user.lastLoginAt = new Date();
  await user.save();
  res.json({ token: issueToken(user), user: user.toPublic() });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user.toPublic() }));

router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const data = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
  req.user.name = data.name;
  await req.user.save();
  res.json({ user: req.user.toPublic() });
}));

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const data = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }), req.body);
  const user = await User.findById(req.user.id).select('+passwordHash');
  if (!(await bcrypt.compare(data.currentPassword, user.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
  user.passwordHash = await bcrypt.hash(data.newPassword, 12);
  await user.save();
  res.json({ ok: true });
}));

export default router;
