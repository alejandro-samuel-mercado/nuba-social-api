import { Router } from 'express';
import { z } from 'zod';
import { ChatMessageType, SuggestionStatus, TopicType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { checkCooldownRemaining, checkTextModeration } from '../../lib/moderation';
import { dispatchNotifications } from '../../lib/notifications';
import { getRestrictedWordsList, getSystemSettings, isStaffRole } from '../../lib/settings';
import { emitToAdmins, emitToThread, emitToTopic, emitToUser } from '../../lib/socket';
import { requireAuth, requireNotMuted, requireStaff } from '../../middleware/auth.middleware';
import { requireFeatureEnabled } from '../../middleware/feature.middleware';

export const chatsRouter = Router();

export const AVAILABLE_STICKERS = [
  { code: 'nuba-goal', label: 'GOOOL!', emoji: '⚽' },
  { code: 'nuba-fire', label: 'Candela', emoji: '🔥' },
  { code: 'nuba-popcorn', label: 'Maratón', emoji: '🍿' },
  { code: 'nuba-tv', label: 'Al Aire', emoji: '📺' },
  { code: 'nuba-love', label: 'Me Encanta', emoji: '💜' },
  { code: 'nuba-party', label: 'Festejo', emoji: '🎉' },
  { code: 'nuba-star', label: 'Top 5★', emoji: '⭐' },
  { code: 'nuba-clap', label: 'Crack', emoji: '👏' },
  { code: 'nuba-ticket', label: 'Suerte', emoji: '🎟️' },
  { code: 'nuba-alarm', label: 'Aviso', emoji: '🚨' },
];

const topicMessageSchema = z.object({
  messageType: z.nativeEnum(ChatMessageType).default(ChatMessageType.TEXT),
  content: z.string().max(800).nullable().optional(),
  stickerCode: z.string().max(40).nullable().optional(),
  imageUrl: z.string().max(500).nullable().optional(),
});

const topicConfigSchema = z.object({
  isLocked: z.boolean().optional(),
  notice: z.string().max(250).nullable().optional(),
});

const createThreadSchema = z.object({
  subject: z.string().min(2).max(120).default('Consulta General'),
  topic: z
    .enum(['FOOTBALL', 'STREAMING', 'TV_CHANNELS', 'NEWS', 'SUPPORT', 'GIVEAWAY', 'OTHER'])
    .default('SUPPORT'),
  message: z.string().min(1).max(1200),
  images: z.array(z.string().max(500)).max(4).default([]),
  isSuggestion: z.boolean().default(false),
  metadata: z.record(z.unknown()).nullable().optional(),
  targetUserId: z.string().uuid().optional(), // Solo staff para iniciar DM directo (ej. ganador de sorteo)
});

const directMessageSchema = z.object({
  content: z.string().max(1200).nullable().optional(),
  images: z.array(z.string().max(500)).max(4).default([]),
  isSuggestion: z.boolean().default(false),
  metadata: z.record(z.unknown()).nullable().optional(),
});

chatsRouter.use(requireAuth);

// ─── STICKERS & RESUMEN DE SALAS POR TEMA ─────────────────────────────────────

chatsRouter.get('/stickers', (_req, res) => {
  res.json({ stickers: AVAILABLE_STICKERS });
});

chatsRouter.get(
  '/topics/summary',
  requireFeatureEnabled('chatsEnabled', true),
  async (_req, res, next) => {
    try {
      const topics: TopicType[] = ['FOOTBALL', 'STREAMING', 'NEWS', 'TV_CHANNELS'];
      const summaries = await Promise.all(
        topics.map(async (topic) => {
          const [config, count, lastMessage] = await Promise.all([
            prisma.topicRoomConfig.upsert({
              where: { topic },
              update: {},
              create: { topic },
            }),
            prisma.topicChatMessage.count({ where: { topic, isDeleted: false } }),
            prisma.topicChatMessage.findFirst({
              where: { topic, isDeleted: false },
              orderBy: { createdAt: 'desc' },
              include: {
                sender: { select: { id: true, displayName: true, username: true, role: true } },
              },
            }),
          ]);
          return { topic, config, messageCount: count, lastMessage };
        })
      );
      res.json({ rooms: summaries, stickers: AVAILABLE_STICKERS });
    } catch (err) {
      next(err);
    }
  }
);

chatsRouter.get(
  '/topics/:topic',
  requireFeatureEnabled('chatsEnabled', true),
  async (req, res, next) => {
    try {
      const topic = z.nativeEnum(TopicType).parse(String(req.params.topic).toUpperCase());
      const limit = Math.min(Number(req.query.limit) || 60, 120);

      const [config, messages, settings] = await Promise.all([
        prisma.topicRoomConfig.upsert({
          where: { topic },
          update: {},
          create: { topic },
        }),
        prisma.topicChatMessage.findMany({
          where: { topic, isDeleted: false },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: {
            sender: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                role: true,
              },
            },
          },
        }),
        getSystemSettings(),
      ]);

      res.json({
        topic,
        config,
        messages: messages.reverse(),
        stickers: AVAILABLE_STICKERS,
        restrictions: {
          chatImagesEnabled: settings.chatImagesEnabled,
          chatImageCooldownSec: settings.chatImageCooldownSec,
          maxLength: settings.maxCommentLength,
          blockLinks: settings.blockLinksInComments,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

chatsRouter.post(
  '/topics/:topic',
  requireFeatureEnabled('chatsEnabled'),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const topic = z.nativeEnum(TopicType).parse(String(req.params.topic).toUpperCase());
      const payload = topicMessageSchema.parse(req.body);
      const isStaff = isStaffRole(req.user!.role);

      const [config, settings, restrictedWords] = await Promise.all([
        prisma.topicRoomConfig.upsert({
          where: { topic },
          update: {},
          create: { topic },
        }),
        getSystemSettings(),
        getRestrictedWordsList(),
      ]);

      if (config.isLocked && !isStaff) {
        res.status(403).json({ error: 'Esta sala está pausada temporalmente por administración.' });
        return;
      }

      if (payload.messageType === ChatMessageType.STICKER) {
        const validSticker = AVAILABLE_STICKERS.find((s) => s.code === payload.stickerCode);
        if (!validSticker) {
          res.status(400).json({ error: 'Sticker inválido.' });
          return;
        }
      }

      if (payload.messageType === ChatMessageType.IMAGE) {
        if (!settings.chatImagesEnabled && !isStaff) {
          res.status(403).json({ error: 'El envío de imágenes en salas está deshabilitado.' });
          return;
        }
        if (!payload.imageUrl) {
          res.status(400).json({ error: 'Debés adjuntar una imagen válida.' });
          return;
        }
        if (!isStaff && settings.chatImageCooldownSec > 0) {
          const lastImg = await prisma.topicChatMessage.findFirst({
            where: {
              senderId: req.user!.id,
              messageType: ChatMessageType.IMAGE,
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          const wait = checkCooldownRemaining(lastImg?.createdAt, settings.chatImageCooldownSec);
          if (wait > 0) {
            res.status(429).json({
              error: `Por seguridad podés enviar otra imagen en ${wait}s.`,
            });
            return;
          }
        }
      }

      let sanitizedContent: string | null = null;
      if (payload.content && payload.content.trim()) {
        const check = checkTextModeration(payload.content, {
          maxLength: 800,
          blockLinks: isStaff ? false : settings.blockLinksInComments,
          restrictedWords,
        });
        if (!check.ok) {
          res.status(400).json({ error: check.reason });
          return;
        }
        sanitizedContent = check.sanitized;
      } else if (
        payload.messageType === ChatMessageType.TEXT ||
        payload.messageType === ChatMessageType.SUGGESTION
      ) {
        res.status(400).json({ error: 'Escribí un mensaje antes de enviar.' });
        return;
      }

      const created = await prisma.topicChatMessage.create({
        data: {
          topic,
          messageType: payload.messageType,
          content: sanitizedContent,
          stickerCode: payload.messageType === 'STICKER' ? payload.stickerCode ?? null : null,
          imageUrl: payload.messageType === 'IMAGE' ? payload.imageUrl ?? null : null,
          senderId: req.user!.id,
        },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true,
            },
          },
        },
      });

      emitToTopic(topic, 'topic_chat:message', created);
      emitToAdmins('admin_topic_chat:activity', { topic, message: created });

      if (payload.messageType === ChatMessageType.SUGGESTION && !isStaff) {
        void dispatchNotifications({
          type: 'SUGGESTION_UPDATE',
          title: `Sugerencia en chat ${topic}`,
          body: `${req.user!.displayName}: ${sanitizedContent || ''}`,
          topic,
          referenceId: created.id,
          referenceType: 'TOPIC_CHAT',
          targetRoles: ['SUPERADMIN', 'ADMIN', 'MODERATOR'],
        });
      }

      res.status(201).json({ message: created });
    } catch (err) {
      next(err);
    }
  }
);

chatsRouter.patch('/topics/:topic/config', requireStaff, async (req, res, next) => {
  try {
    const topic = z.nativeEnum(TopicType).parse(String(req.params.topic).toUpperCase());
    const data = topicConfigSchema.parse(req.body);
    const config = await prisma.topicRoomConfig.upsert({
      where: { topic },
      update: data,
      create: { topic, ...data },
    });
    emitToTopic(topic, 'topic_chat:config', config);
    res.json({ config });
  } catch (err) {
    next(err);
  }
});

chatsRouter.delete('/topics/:topic/messages/:messageId', async (req, res, next) => {
  try {
    const msg = await prisma.topicChatMessage.findUnique({ where: { id: req.params.messageId } });
    if (!msg) {
      res.status(404).json({ error: 'Mensaje no encontrado.' });
      return;
    }
    const isStaff = isStaffRole(req.user!.role);
    if (!isStaff && msg.senderId !== req.user!.id) {
      res.status(403).json({ error: 'No tenés permiso para borrar este mensaje.' });
      return;
    }
    await prisma.topicChatMessage.update({
      where: { id: msg.id },
      data: { isDeleted: true },
    });
    emitToTopic(msg.topic, 'topic_chat:deleted', { topic: msg.topic, messageId: msg.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── CHAT DIRECTO & SUGERENCIAS ORGANIZADAS CON ADMIN ─────────────────────────

chatsRouter.get(
  '/direct/threads',
  requireFeatureEnabled('directChatEnabled', true),
  async (req, res, next) => {
    try {
      const isStaff = isStaffRole(req.user!.role);
      const topic = typeof req.query.topic === 'string' && req.query.topic !== 'ALL' ? req.query.topic : undefined;
      const statusParam = typeof req.query.status === 'string' && req.query.status !== 'ALL' ? req.query.status : undefined;
      const unreadOnly = req.query.unreadOnly === 'true';
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

      const where: Record<string, unknown> = {};
      if (!isStaff) {
        where.userId = req.user!.id;
      } else {
        if (unreadOnly) where.unreadForAdmin = { gt: 0 };
        if (search) {
          where.OR = [
            { subject: { contains: search, mode: 'insensitive' } },
            { user: { displayName: { contains: search, mode: 'insensitive' } } },
            { user: { username: { contains: search, mode: 'insensitive' } } },
          ];
        }
      }
      if (topic) where.topic = topic;
      if (statusParam && Object.values(SuggestionStatus).includes(statusParam as SuggestionStatus)) {
        where.status = statusParam;
      }

      const threads = await prisma.directThread.findMany({
        where,
        orderBy: isStaff
          ? [{ unreadForAdmin: 'desc' }, { lastMessageAt: 'desc' }]
          : [{ lastMessageAt: 'desc' }],
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: {
              sender: { select: { id: true, displayName: true, role: true } },
            },
          },
          _count: { select: { messages: true } },
        },
      });

      const byTopicCounts: Record<string, number> = {};
      for (const t of threads) {
        byTopicCounts[t.topic] = (byTopicCounts[t.topic] || 0) + 1;
      }

      res.json({
        threads: threads.map((t) => ({
          ...t,
          lastMessage: t.messages[0] || null,
          messages: undefined,
        })),
        byTopicCounts,
      });
    } catch (err) {
      next(err);
    }
  }
);

chatsRouter.post(
  '/direct/threads',
  requireFeatureEnabled('directChatEnabled', true),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const data = createThreadSchema.parse(req.body);
      const isStaff = isStaffRole(req.user!.role);
      const ownerUserId = isStaff && data.targetUserId ? data.targetUserId : req.user!.id;

      const restrictedWords = await getRestrictedWordsList();
      const check = checkTextModeration(data.message, {
        maxLength: 1200,
        blockLinks: false,
        restrictedWords,
      });
      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }

      const thread = await prisma.directThread.create({
        data: {
          userId: ownerUserId,
          subject: data.subject.trim(),
          topic: data.topic,
          status: SuggestionStatus.OPEN,
          unreadForAdmin: isStaff ? 0 : 1,
          unreadForUser: isStaff && ownerUserId !== req.user!.id ? 1 : 0,
          lastMessageAt: new Date(),
          messages: {
            create: {
              senderId: req.user!.id,
              content: check.sanitized,
              images: data.images,
              isSuggestion: data.isSuggestion,
              metadata: (data.metadata ?? undefined) as object | undefined,
            },
          },
        },
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatarUrl: true },
          },
          messages: {
            include: {
              sender: { select: { id: true, username: true, displayName: true, avatarUrl: true, role: true } },
            },
          },
        },
      });

      if (isStaff && ownerUserId !== req.user!.id) {
        emitToUser(ownerUserId, 'direct:thread_new', thread);
        void dispatchNotifications({
          type: 'DIRECT_MESSAGE',
          title: 'Nuevo mensaje de Administración',
          body: `${thread.subject}: ${check.sanitized.slice(0, 120)}`,
          referenceId: thread.id,
          referenceType: 'DIRECT_THREAD',
          targetUserIds: [ownerUserId],
        });
      } else {
        emitToAdmins('direct:thread_new', thread);
        void dispatchNotifications({
          type: data.isSuggestion ? 'SUGGESTION_UPDATE' : 'DIRECT_MESSAGE',
          title: data.isSuggestion
            ? `Nueva sugerencia (${data.topic})`
            : `Nuevo mensaje directo de ${req.user!.displayName}`,
          body: `${thread.subject} — ${check.sanitized.slice(0, 120)}`,
          referenceId: thread.id,
          referenceType: 'DIRECT_THREAD',
          targetRoles: ['SUPERADMIN', 'ADMIN', 'MODERATOR'],
        });
      }

      res.status(201).json({ thread });
    } catch (err) {
      next(err);
    }
  }
);

chatsRouter.get('/direct/threads/:threadId', async (req, res, next) => {
  try {
    const thread = await prisma.directThread.findUnique({
      where: { id: req.params.threadId },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: {
              select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
            },
          },
        },
      },
    });

    if (!thread) {
      res.status(404).json({ error: 'Conversación no encontrada.' });
      return;
    }

    const isStaff = isStaffRole(req.user!.role);
    if (!isStaff && thread.userId !== req.user!.id) {
      res.status(403).json({ error: 'Acceso denegado a esta conversación.' });
      return;
    }

    res.json({ thread });
  } catch (err) {
    next(err);
  }
});

chatsRouter.post(
  '/direct/threads/:threadId/messages',
  requireFeatureEnabled('directChatEnabled', true),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const payload = directMessageSchema.parse(req.body);
      const thread = await prisma.directThread.findUnique({
        where: { id: String(req.params.threadId) },
      });
      if (!thread) {
        res.status(404).json({ error: 'Conversación no encontrada.' });
        return;
      }

      const isStaff = isStaffRole(req.user!.role);
      if (!isStaff && thread.userId !== req.user!.id) {
        res.status(403).json({ error: 'No pertenecés a esta conversación.' });
        return;
      }

      let sanitizedContent: string | null = null;
      if (payload.content && payload.content.trim()) {
        const restrictedWords = await getRestrictedWordsList();
        const check = checkTextModeration(payload.content, {
          maxLength: 1200,
          blockLinks: false,
          restrictedWords,
        });
        if (!check.ok) {
          res.status(400).json({ error: check.reason });
          return;
        }
        sanitizedContent = check.sanitized;
      } else if (payload.images.length === 0) {
        res.status(400).json({ error: 'Escribí un mensaje o adjuntá una imagen.' });
        return;
      }

      const [message, updatedThread] = await prisma.$transaction([
        prisma.directMessage.create({
          data: {
            threadId: thread.id,
            senderId: req.user!.id,
            content: sanitizedContent,
            images: payload.images,
            isSuggestion: payload.isSuggestion,
            metadata: (payload.metadata ?? undefined) as object | undefined,
          },
          include: {
            sender: {
              select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
            },
          },
        }),
        prisma.directThread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: new Date(),
            ...(isStaff ? { unreadForUser: { increment: 1 } } : { unreadForAdmin: { increment: 1 } }),
          },
        }),
      ]);

      emitToThread(thread.id, 'direct:message', { threadId: thread.id, message });
      if (isStaff) {
        emitToUser(thread.userId, 'direct:thread_updated', updatedThread);
        void dispatchNotifications({
          type: 'DIRECT_MESSAGE',
          title: `Respuesta de Admin • ${thread.subject}`,
          body: sanitizedContent || 'Se adjuntó una imagen.',
          referenceId: thread.id,
          referenceType: 'DIRECT_THREAD',
          targetUserIds: [thread.userId],
        });
      } else {
        emitToAdmins('direct:thread_updated', updatedThread);
        void dispatchNotifications({
          type: payload.isSuggestion ? 'SUGGESTION_UPDATE' : 'DIRECT_MESSAGE',
          title: `Nuevo mensaje de ${req.user!.displayName}`,
          body: `${thread.subject}: ${sanitizedContent || 'Imagen adjunta'}`,
          referenceId: thread.id,
          referenceType: 'DIRECT_THREAD',
          targetRoles: ['SUPERADMIN', 'ADMIN', 'MODERATOR'],
        });
      }

      res.status(201).json({ message, thread: updatedThread });
    } catch (err) {
      next(err);
    }
  }
);

chatsRouter.post('/direct/threads/:threadId/read', async (req, res, next) => {
  try {
    const thread = await prisma.directThread.findUnique({
      where: { id: req.params.threadId },
    });
    if (!thread) {
      res.status(404).json({ error: 'Conversación no encontrada.' });
      return;
    }

    const isStaff = isStaffRole(req.user!.role);
    if (!isStaff && thread.userId !== req.user!.id) {
      res.status(403).json({ error: 'Acceso denegado.' });
      return;
    }

    await prisma.directThread.update({
      where: { id: thread.id },
      data: isStaff ? { unreadForAdmin: 0 } : { unreadForUser: 0 },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

chatsRouter.patch('/direct/threads/:threadId/status', requireStaff, async (req, res, next) => {
  try {
    const status = z.nativeEnum(SuggestionStatus).parse(req.body?.status);
    const updated = await prisma.directThread.update({
      where: { id: String(req.params.threadId) },
      data: { status },
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    emitToUser(updated.userId, 'direct:thread_updated', updated);
    emitToAdmins('direct:thread_updated', updated);
    void dispatchNotifications({
      type: 'SUGGESTION_UPDATE',
      title: `Actualización de tu solicitud (${status})`,
      body: `Tu hilo "${updated.subject}" pasó a estado ${status}.`,
      referenceId: updated.id,
      referenceType: 'DIRECT_THREAD',
      targetUserIds: [updated.userId],
    });

    res.json({ thread: updated });
  } catch (err) {
    next(err);
  }
});
