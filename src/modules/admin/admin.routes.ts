import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getRestrictedWordsList, getSystemSettings } from '../../lib/settings';
import { emitToAll } from '../../lib/socket';
import { requireAdmin, requireAuth, requireStaff } from '../../middleware/auth.middleware';

export const adminRouter = Router();

const settingsSchema = z.object({
  appName: z.string().min(2).max(60).optional(),
  announcementBanner: z.string().max(300).nullable().optional(),
  chatsEnabled: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
  likesEnabled: z.boolean().optional(),
  giveawaysEnabled: z.boolean().optional(),
  pollsEnabled: z.boolean().optional(),
  historyEnabled: z.boolean().optional(),
  directChatEnabled: z.boolean().optional(),
  chatImagesEnabled: z.boolean().optional(),
  ratingsEnabled: z.boolean().optional(),
  maxCommentLength: z.number().int().min(50).max(1000).optional(),
  commentCooldownSec: z.number().int().min(0).max(300).optional(),
  chatImageCooldownSec: z.number().int().min(0).max(600).optional(),
  blockLinksInComments: z.boolean().optional(),
});

const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Solo letras, números, punto, guión y guión bajo'),
  email: z.string().email().nullable().optional(),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
  displayName: z.string().min(2).max(60),
  bio: z.string().max(250).nullable().optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  role: z.nativeEnum(UserRole).default(UserRole.USER),
  preferredTheme: z.enum(['classic', 'cute', 'minimal', 'concert', 'oscuro']).optional(),
  customColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

const updateUserSchema = z.object({
  displayName: z.string().min(2).max(60).optional(),
  email: z.string().email().nullable().optional(),
  bio: z.string().max(250).nullable().optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.boolean().optional(),
  isMuted: z.boolean().optional(),
  password: z.string().min(6).optional(),
  preferredTheme: z.enum(['classic', 'cute', 'minimal', 'concert', 'oscuro']).optional(),
});

adminRouter.use(requireAuth);

adminRouter.get('/settings', requireStaff, async (_req, res, next) => {
  try {
    const settings = await getSystemSettings();
    const restrictedWords = await prisma.restrictedWord.findMany({
      orderBy: { word: 'asc' },
    });
    res.json({ settings, restrictedWords });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const data = settingsSchema.parse(req.body);
    await getSystemSettings();
    const settings = await prisma.systemSettings.update({
      where: { id: 'singleton' },
      data,
    });
    emitToAll('settings:updated', settings);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/restricted-words', requireStaff, async (_req, res, next) => {
  try {
    const words = await prisma.restrictedWord.findMany({ orderBy: { word: 'asc' } });
    res.json({ words });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/restricted-words', requireStaff, async (req, res, next) => {
  try {
    const word = z.string().min(2).max(60).parse(req.body?.word).trim().toLowerCase();
    const existing = await prisma.restrictedWord.findUnique({ where: { word } });
    if (existing) {
      res.json({ word: existing });
      return;
    }
    const created = await prisma.restrictedWord.create({ data: { word } });
    res.status(201).json({ word: created, allWords: await getRestrictedWordsList() });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/restricted-words/:id', requireStaff, async (req, res, next) => {
  try {
    await prisma.restrictedWord.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/dashboard', requireStaff, async (_req, res, next) => {
  try {
    const [
      totalUsers,
      activeUsers,
      totalPosts,
      pendingPosts,
      liveMatches,
      upcomingMatches,
      openPolls,
      openGiveaways,
      unreadThreads,
      recentThreads,
      settings,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.post.count(),
      prisma.post.count({ where: { status: 'PENDING' } }),
      prisma.match.count({ where: { status: { in: ['LIVE', 'HALFTIME'] } } }),
      prisma.match.count({ where: { status: 'UPCOMING' } }),
      prisma.poll.count({ where: { isClosed: false } }),
      prisma.giveaway.count({ where: { status: { in: ['OPEN', 'DRAWING'] } } }),
      prisma.directThread.count({ where: { unreadForAdmin: { gt: 0 } } }),
      prisma.directThread.findMany({
        take: 5,
        orderBy: { lastMessageAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      }),
      getSystemSettings(),
    ]);

    const postsByTopic = await prisma.post.groupBy({
      by: ['topic'],
      _count: { id: true },
    });

    res.json({
      stats: {
        totalUsers,
        activeUsers,
        totalPosts,
        pendingPosts,
        liveMatches,
        upcomingMatches,
        openPolls,
        openGiveaways,
        unreadThreads,
        postsByTopic: Object.fromEntries(postsByTopic.map((p) => [p.topic, p._count.id])),
      },
      recentThreads,
      settings,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users', requireStaff, async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const users = await prisma.user.findMany({
      where: search
        ? {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { displayName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        isMuted: true,
        preferredTheme: true,
        customColor: true,
        lastVisitAt: true,
        createdAt: true,
        _count: {
          select: {
            posts: true,
            comments: true,
            giveawayEntries: true,
            directThreadsAsUser: true,
          },
        },
      },
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const data = createUserSchema.parse(req.body);
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: data.username, mode: 'insensitive' } },
          ...(data.email ? [{ email: { equals: data.email, mode: 'insensitive' as const } }] : []),
        ],
      },
    });
    if (existing) {
      res.status(409).json({ error: 'Ya existe una cuenta con ese usuario o email.' });
      return;
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const created = await prisma.user.create({
      data: {
        username: data.username.toLowerCase(),
        email: data.email ?? null,
        passwordHash,
        displayName: data.displayName,
        bio: data.bio ?? null,
        avatarUrl: data.avatarUrl ?? null,
        role: data.role,
        preferredTheme: data.preferredTheme || 'classic',
        customColor: data.customColor ?? null,
        notificationPreference: { create: {} },
      },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        isMuted: true,
        preferredTheme: true,
        customColor: true,
        createdAt: true,
      },
    });
    res.status(201).json({ user: created });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const targetId = String(req.params.id);
    const data = updateUserSchema.parse(req.body);
    const { password, ...rest } = data;
    const updateData: Record<string, unknown> = { ...rest };
    if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
    }

    if (targetId === req.user!.id && data.isActive === false) {
      res.status(400).json({ error: 'No podés desactivar tu propia cuenta administradora.' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        isMuted: true,
        preferredTheme: true,
        customColor: true,
        lastVisitAt: true,
      },
    });
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const targetId = String(req.params.id);
    if (targetId === req.user!.id) {
      res.status(400).json({ error: 'No podés eliminar tu propia cuenta.' });
      return;
    }
    await prisma.user.delete({ where: { id: targetId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
