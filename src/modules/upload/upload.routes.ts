import { Router } from 'express';
import { imageUpload } from '../../lib/upload';
import { getSystemSettings, isStaffRole } from '../../lib/settings';
import { requireAuth, requireNotMuted } from '../../middleware/auth.middleware';

export const uploadRouter = Router();

uploadRouter.post(
  '/single',
  requireAuth,
  requireNotMuted,
  async (req, res, next) => {
    try {
      const folder = typeof req.query.folder === 'string' ? req.query.folder : 'general';
      if (folder === 'chat' && !isStaffRole(req.user!.role)) {
        const settings = await getSystemSettings();
        if (!settings.chatsEnabled || !settings.chatImagesEnabled) {
          res.status(403).json({
            error: 'El envío de imágenes en el chat está deshabilitado por administración.',
          });
          return;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  },
  imageUpload.single('file'),
  (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió ninguna imagen.' });
      return;
    }
    const folder = typeof req.query.folder === 'string' ? req.query.folder : 'general';
    const safeFolder = ['posts', 'teams', 'chat', 'avatars', 'giveaways', 'general'].includes(folder)
      ? folder
      : 'general';
    res.status(201).json({
      url: `/uploads/${safeFolder}/${req.file.filename}`,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  }
);

uploadRouter.post(
  '/multiple',
  requireAuth,
  requireNotMuted,
  imageUpload.array('files', 4),
  (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No se recibieron imágenes.' });
      return;
    }
    const folder = typeof req.query.folder === 'string' ? req.query.folder : 'general';
    const safeFolder = ['posts', 'teams', 'chat', 'avatars', 'giveaways', 'general'].includes(folder)
      ? folder
      : 'general';
    res.status(201).json({
      urls: files.map((f) => `/uploads/${safeFolder}/${f.filename}`),
    });
  }
);
