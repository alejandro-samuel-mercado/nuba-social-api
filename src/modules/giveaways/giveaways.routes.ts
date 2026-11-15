import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { GiveawayStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { dispatchNotifications } from '../../lib/notifications';
import { getSystemSettings, isStaffRole } from '../../lib/settings';
import { emitToAdmins, emitToAll, emitToUser } from '../../lib/socket';
import { requireAdmin, requireAuth, requireNotMuted, requireStaff } from '../../middleware/auth.middleware';
import { requireFeatureEnabled } from '../../middleware/feature.middleware';

export const giveawaysRouter = Router();

/**
 * Selección aleatoria criptográficamente uniforme del índice ganador.
 */
export function pickCryptoWinnerIndex(participantCount: number): number {
  if (participantCount <= 0) {
    throw new Error('Debe haber al menos un participante anotado para sortear.');
  }
  return crypto.randomInt(0, participantCount);
}

const giveawaySchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(3000).nullable().optional(),
  prizeDescription: z.string().min(2).max(300),
  imageUrl: z.string().max(500).nullable().optional(),
  scheduledAt: z.string().datetime().or(z.string().min(8)),
  maxEntries: z.number().int().min(2).max(5000).nullable().optional(),
});

giveawaysRouter.use(requireAuth);

giveawaysRouter.get('/', requireFeatureEnabled('giveawaysEnabled', true), async (req, res, next) => {
  try {
    const isStaff = isStaffRole(req.user!.role);
    const settings = await getSystemSettings();

    const giveaways = await prisma.giveaway.findMany({
      orderBy: [{ status: 'asc' }, { scheduledAt: 'desc' }],
      include: {
        winner: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
        entries: {
          orderBy: { createdAt: 'asc' },
          include: {
            user: {
              select: { id: true, username: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
    });

    const mapped = giveaways.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      prizeDescription: g.prizeDescription,
      imageUrl: g.imageUrl,
      scheduledAt: g.scheduledAt,
      maxEntries: g.maxEntries,
      status: g.status,
      winner: g.winner,
      drawnAt: g.drawnAt,
      createdAt: g.createdAt,
      entriesCount: g.entries.length,
      isEnrolled: g.entries.some((e) => e.userId === req.user!.id),
      participants: g.entries.map((e) => e.user),
    }));

    const active = mapped.filter((g) => g.status === 'OPEN' || g.status === 'DRAWING');
    const history =
      settings.historyEnabled || isStaff
        ? mapped.filter((g) => g.status === 'COMPLETED' || g.status === 'CANCELLED')
        : [];

    res.json({
      giveaways: active,
      history,
      historyEnabled: settings.historyEnabled,
    });
  } catch (err) {
    next(err);
  }
});

giveawaysRouter.post('/', requireStaff, async (req, res, next) => {
  try {
    const data = giveawaySchema.parse(req.body);
    const created = await prisma.giveaway.create({
      data: {
        title: data.title.trim(),
        description: data.description?.trim() ?? null,
        prizeDescription: data.prizeDescription.trim(),
        imageUrl: data.imageUrl ?? null,
        scheduledAt: new Date(data.scheduledAt),
        maxEntries: data.maxEntries ?? null,
      },
    });

    emitToAll('giveaway:new', { giveaway: created });
    void dispatchNotifications({
      type: 'GIVEAWAY_OPEN',
      title: '🎁 ¡Nuevo sorteo abierto en Nuba Club!',
      body: `${created.title} • Premio: ${created.prizeDescription}`,
      referenceId: created.id,
      referenceType: 'GIVEAWAY',
      excludeUserId: req.user!.id,
    });

    res.status(201).json({ giveaway: created });
  } catch (err) {
    next(err);
  }
});

giveawaysRouter.patch('/:id', requireStaff, async (req, res, next) => {
  try {
    const partial = giveawaySchema.partial().extend({
      status: z.nativeEnum(GiveawayStatus).optional(),
    }).parse(req.body);

    const giveawayId = String(req.params.id);
    const updated = await prisma.giveaway.update({
      where: { id: giveawayId },
      data: {
        ...partial,
        scheduledAt: partial.scheduledAt ? new Date(partial.scheduledAt) : undefined,
      },
    });
    emitToAll('giveaway:updated', { giveaway: updated });
    res.json({ giveaway: updated });
  } catch (err) {
    next(err);
  }
});

giveawaysRouter.post(
  '/:id/enroll',
  requireFeatureEnabled('giveawaysEnabled'),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const giveaway = await prisma.giveaway.findUnique({
        where: { id: String(req.params.id) },
        include: { _count: { select: { entries: true } } },
      });

      if (!giveaway) {
        res.status(404).json({ error: 'Sorteo no encontrado.' });
        return;
      }
      if (giveaway.status !== GiveawayStatus.OPEN) {
        res.status(400).json({ error: 'Las inscripciones para este sorteo ya cerraron.' });
        return;
      }
      if (giveaway.maxEntries && giveaway._count.entries >= giveaway.maxEntries) {
        res.status(400).json({ error: 'Se alcanzó el cupo máximo de participantes.' });
        return;
      }

      const existing = await prisma.giveawayEntry.findUnique({
        where: {
          giveawayId_userId: { giveawayId: giveaway.id, userId: req.user!.id },
        },
      });

      if (!existing) {
        await prisma.giveawayEntry.create({
          data: { giveawayId: giveaway.id, userId: req.user!.id },
        });
      }

      const entriesCount = await prisma.giveawayEntry.count({
        where: { giveawayId: giveaway.id },
      });

      emitToAll('giveaway:enrolled', {
        giveawayId: giveaway.id,
        entriesCount,
        user: {
          id: req.user!.id,
          username: req.user!.username,
          displayName: req.user!.displayName,
          avatarUrl: req.user!.avatarUrl,
        },
      });

      res.json({ ok: true, isEnrolled: true, entriesCount });
    } catch (err) {
      next(err);
    }
  }
);

giveawaysRouter.post('/:id/draw', requireAdmin, async (req, res, next) => {
  try {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: String(req.params.id) },
      include: {
        entries: {
          include: {
            user: {
              select: { id: true, username: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
    });

    if (!giveaway) {
      res.status(404).json({ error: 'Sorteo no encontrado.' });
      return;
    }
    if (giveaway.status === GiveawayStatus.COMPLETED && giveaway.winnerId) {
      res.status(400).json({ error: 'Este sorteo ya tiene un ganador registrado.' });
      return;
    }
    if (giveaway.entries.length === 0) {
      res.status(400).json({ error: 'No hay usuarios anotados en este sorteo.' });
      return;
    }

    const winnerIdx = pickCryptoWinnerIndex(giveaway.entries.length);
    const chosenEntry = giveaway.entries[winnerIdx];
    const drawnAt = new Date();

    const updated = await prisma.giveaway.update({
      where: { id: giveaway.id },
      data: {
        status: GiveawayStatus.COMPLETED,
        winnerId: chosenEntry.user.id,
        drawnAt,
      },
      include: {
        winner: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
    });

    const liveDrawPayload = {
      giveawayId: updated.id,
      title: updated.title,
      prizeDescription: updated.prizeDescription,
      drawnAt,
      winner: updated.winner,
      participants: giveaway.entries.map((e) => e.user),
    };

    emitToAll('giveaway:live_draw', liveDrawPayload);

    void dispatchNotifications({
      type: 'GIVEAWAY_WIN',
      title: '🏆 ¡GANASTE EL SORTEO!',
      body: `Saliste ganador en "${updated.title}" (${updated.prizeDescription}). Administración te contactará pronto.`,
      referenceId: updated.id,
      referenceType: 'GIVEAWAY',
      targetUserIds: [chosenEntry.user.id],
    });

    void dispatchNotifications({
      type: 'GIVEAWAY_LIVE',
      title: `🎉 Resultado del sorteo: ${updated.title}`,
      body: `¡${chosenEntry.user.displayName} (@${chosenEntry.user.username}) ganó ${updated.prizeDescription}!`,
      referenceId: updated.id,
      referenceType: 'GIVEAWAY',
      excludeUserId: chosenEntry.user.id,
    });

    res.json({
      giveaway: updated,
      drawResult: liveDrawPayload,
    });
  } catch (err) {
    next(err);
  }
});

giveawaysRouter.post('/:id/contact-winner', requireStaff, async (req, res, next) => {
  try {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: String(req.params.id) },
      include: { winner: true },
    });

    if (!giveaway || !giveaway.winner) {
      res.status(404).json({ error: 'Este sorteo aún no tiene un ganador.' });
      return;
    }

    const customMsg =
      typeof req.body?.message === 'string' && req.body.message.trim()
        ? req.body.message.trim()
        : `¡Felicitaciones ${giveaway.winner.displayName}! Ganaste "${giveaway.title}" (${giveaway.prizeDescription}). Escribinos por acá para entregarte tu premio.`;

    const existingThread = await prisma.directThread.findFirst({
      where: {
        userId: giveaway.winner.id,
        topic: 'GIVEAWAY',
        subject: { contains: giveaway.title },
      },
    });

    const thread = existingThread
      ? await prisma.directThread.update({
          where: { id: existingThread.id },
          data: {
            lastMessageAt: new Date(),
            unreadForUser: { increment: 1 },
            messages: {
              create: {
                senderId: req.user!.id,
                content: customMsg,
                metadata: { giveawayId: giveaway.id, prize: giveaway.prizeDescription },
              },
            },
          },
        })
      : await prisma.directThread.create({
          data: {
            userId: giveaway.winner.id,
            subject: `Premio Sorteo: ${giveaway.title}`,
            topic: 'GIVEAWAY',
            status: 'APPROVED',
            unreadForUser: 1,
            unreadForAdmin: 0,
            messages: {
              create: {
                senderId: req.user!.id,
                content: customMsg,
                metadata: { giveawayId: giveaway.id, prize: giveaway.prizeDescription },
              },
            },
          },
        });

    emitToUser(giveaway.winner.id, 'direct:thread_new', thread);
    emitToAdmins('direct:thread_updated', thread);
    void dispatchNotifications({
      type: 'DIRECT_MESSAGE',
      title: '🎁 Mensaje por tu premio de sorteo',
      body: customMsg.slice(0, 140),
      referenceId: thread.id,
      referenceType: 'DIRECT_THREAD',
      targetUserIds: [giveaway.winner.id],
    });

    res.json({ thread });
  } catch (err) {
    next(err);
  }
});

giveawaysRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const giveawayId = String(req.params.id);
    await prisma.giveaway.delete({ where: { id: giveawayId } });
    emitToAll('giveaway:deleted', { giveawayId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
