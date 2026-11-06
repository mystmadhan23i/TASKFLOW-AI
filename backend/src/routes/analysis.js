import { Router } from 'express';
import { z } from 'zod';
import Analysis from '../models/Analysis.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, asyncHandler, parse, requireId } from '../utils/http.js';
import { analyze, aiConfigured } from '../services/aiProvider.js';
import rateLimit from 'express-rate-limit';

const router = Router();
router.use(requireAuth);

const MAX_CHARS = 60000;

router.get('/status', (req, res) => res.json({ aiConfigured: aiConfigured(), maxChars: MAX_CHARS }));

router.post('/', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }),
  asyncHandler(async (req, res) => {
    const data = parse(z.object({
      text: z.string().min(1, 'Paste some text to analyze').max(MAX_CHARS, `Input is limited to ${MAX_CHARS} characters`),
      filename: z.string().trim().max(150).optional().default('pasted-text')
    }), req.body);
    const result = await analyze(data.text, data.filename);
    const saved = await Analysis.create({
      user: req.user.id, filename: data.filename, detectedType: result.detectedType, provider: result.provider,
      summary: result.summary, findings: result.findings, nextSteps: result.nextSteps, counts: result.counts,
      inputChars: data.text.length, redactions: result.redactions, aiNote: result.aiNote
    });
    res.status(201).json({ analysis: { ...saved.toJSON(), counts: result.counts } });
  }));

router.get('/', asyncHandler(async (req, res) => {
  const list = await Analysis.find({ user: req.user.id }).select('filename detectedType provider summary counts createdAt').sort({ createdAt: -1 }).limit(50);
  res.json({ analyses: list.map((a) => ({ ...a.toJSON(), counts: Object.fromEntries(a.counts || []) })) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const a = await Analysis.findOne({ _id: requireId(req.params.id), user: req.user.id });
  if (!a) throw new HttpError(404, 'Analysis not found');
  res.json({ analysis: { ...a.toJSON(), counts: Object.fromEntries(a.counts || []) } });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await Analysis.deleteOne({ _id: requireId(req.params.id), user: req.user.id });
  res.json({ ok: true });
}));

export default router;
