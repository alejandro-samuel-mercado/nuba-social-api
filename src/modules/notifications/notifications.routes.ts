import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth.middleware';

export const notificationsRouter = Router();

const prefsSchema = z.object({
  footballPosts: z.boolean().optional(),
  streamingPosts: z.boolean().optional(),
  newsPosts: z.boolean().optional(),
  tvPosts: z.boolean().optional(),
  topicChats: z.boolean().optional(),
  directMessages: z.boolean().optional(),
  adminSuggestions: z.boolean().optional(),
  polls: z.boolean().optional(),
  giveaways: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
});

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({
        where: { userId: req.user!.id, isRead: false },
      }),
    ]);
    res.json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: { isRead: true },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/preferences', async (req, res, next) => {
  try {
    const preferences = await prisma.notificationPreference.upsert({
      where: { userId: req.user!.id },
      update: {},
      create: { userId: req.user!.id },
    });
    res.json({ preferences });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.put('/preferences', async (req, res, next) => {
  try {
    const data = prefsSchema.parse(req.body);
    const preferences = await prisma.notificationPreference.upsert({
      where: { userId: req.user!.id },
      update: data,
      create: { userId: req.user!.id, ...data },
    });
    res.json({ preferences });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post('/push-token', async (req, res, next) => {
  try {
    const token = z.string().max(255).nullable().parse(req.body?.token ?? null);
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { expoPushToken: token },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
