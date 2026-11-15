import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { ensureUploadDirs, getUploadRoot } from './lib/upload';
import { getSystemSettings } from './lib/settings';
import { requireAuth } from './middleware/auth.middleware';
import { errorHandler } from './middleware/error.middleware';
import { authRouter } from './modules/auth/auth.routes';
import { uploadRouter } from './modules/upload/upload.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { postsRouter } from './modules/posts/posts.routes';
import { footballRouter } from './modules/football/football.routes';
import { integrationsRouter } from './modules/integrations/integrations.routes';
import { chatsRouter } from './modules/chats/chats.routes';
import { pollsRouter } from './modules/polls/polls.routes';
import { giveawaysRouter } from './modules/giveaways/giveaways.routes';

export function createApp() {
  const app = express();

  ensureUploadDirs();

  const rawOrigins = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
  const allowedOrigins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          cb(null, true);
          return;
        }
        // Permitir requests desde apps móviles Expo / localhost
        if (origin.startsWith('http://localhost') || origin.startsWith('http://192.168.') || origin.startsWith('http://10.')) {
          cb(null, true);
          return;
        }
        cb(null, true);
      },
      credentials: true,
    })
  );

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de acceso. Probá en unos minutos.' },
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'nuba-social-api', timestamp: new Date().toISOString() });
  });

  // Archivos subidos accesibles para imágenes de avisos, escudos, chat, sorteos
  app.use('/uploads', express.static(getUploadRoot()));

  // Rutas de autenticación (acceso cerrado: sin registro público)
  app.use('/api/auth', authLimiter, authRouter);

  // Settings visibles solo para usuarios autenticados
  app.get('/api/settings', requireAuth, async (_req, res, next) => {
    try {
      const settings = await getSystemSettings();
      res.json({ settings });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/upload', uploadRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/football', footballRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/chats', chatsRouter);
  app.use('/api/polls', pollsRouter);
  app.use('/api/giveaways', giveawaysRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada en Nuba Club API.' });
  });

  app.use(errorHandler);
  return app;
}
