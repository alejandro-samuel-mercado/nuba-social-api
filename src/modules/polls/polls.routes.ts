import { Router } from 'express';
import { z } from 'zod';
import { TopicType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { dispatchNotifications } from '../../lib/notifications';
import { emitToAll } from '../../lib/socket';
import { requireAuth, requireNotMuted, requireStaff } from '../../middleware/auth.middleware';
import { requireFeatureEnabled } from '../../middleware/feature.middleware';

export const pollsRouter = Router();

const createPollSchema = z.object({
  question: z.string().min(4).max(250),
  description: z.string().max(500).nullable().optional(),
  topic: z.nativeEnum(TopicType).nullable().optional(),
  allowMultiple: z.boolean().default(false),
  endsAt: z.string().datetime().nullable().optional(),
  options: z.array(z.string().min(1).max(160)).min(2).max(10),
});

async function formatPoll(pollId: string, currentUserId: string) {
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: {
      options: {
        orderBy: { sortOrder: 'asc' },
        include: {
          _count: { select: { votes: true } },
        },
      },
      votes: {
        where: { userId: currentUserId },
        select: { optionId: true },
      },
      _count: { select: { votes: true } },
    },
  });
  if (!poll) return null;

  const uniqueVoterRows = await prisma.pollVote.findMany({
    where: { pollId: poll.id },
    distinct: ['userId'],
    select: { userId: true },
  });

  const totalVotes = poll.options.reduce((acc, opt) => acc + opt._count.votes, 0);
  return {
    id: poll.id,
    question: poll.question,
    description: poll.description,
    topic: poll.topic,
    allowMultiple: poll.allowMultiple,
    isClosed: poll.isClosed || (poll.endsAt ? poll.endsAt < new Date() : false),
    endsAt: poll.endsAt,
    createdAt: poll.createdAt,
    totalVotes,
    totalVoters: uniqueVoterRows.length,
    userVotedOptionIds: poll.votes.map((v) => v.optionId),
    options: poll.options.map((o) => ({
      id: o.id,
      label: o.label,
      sortOrder: o.sortOrder,
      votes: o._count.votes,
      percentage: totalVotes > 0 ? Math.round((o._count.votes / totalVotes) * 100) : 0,
    })),
  };
}

pollsRouter.use(requireAuth);

pollsRouter.get('/', requireFeatureEnabled('pollsEnabled', true), async (req, res, next) => {
  try {
    const rawPolls = await prisma.poll.findMany({
      orderBy: [{ isClosed: 'asc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    const formatted = await Promise.all(rawPolls.map((p) => formatPoll(p.id, req.user!.id)));
    res.json({ polls: formatted.filter(Boolean) });
  } catch (err) {
    next(err);
  }
});

pollsRouter.post('/', requireStaff, async (req, res, next) => {
  try {
    const data = createPollSchema.parse(req.body);
    const created = await prisma.poll.create({
      data: {
        question: data.question.trim(),
        description: data.description?.trim() ?? null,
        topic: data.topic ?? null,
        allowMultiple: data.allowMultiple,
        endsAt: data.endsAt ? new Date(data.endsAt) : null,
        options: {
          create: data.options.map((label, idx) => ({
            label: label.trim(),
            sortOrder: idx,
          })),
        },
      },
    });

    const formatted = await formatPoll(created.id, req.user!.id);
    emitToAll('poll:new', { poll: formatted });
    void dispatchNotifications({
      type: 'NEW_POLL',
      title: '📊 Nueva encuesta en Nuba Club',
      body: created.question,
      topic: created.topic,
      referenceId: created.id,
      referenceType: 'POLL',
      excludeUserId: req.user!.id,
    });

    res.status(201).json({ poll: formatted });
  } catch (err) {
    next(err);
  }
});

pollsRouter.post(
  '/:id/vote',
  requireFeatureEnabled('pollsEnabled'),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const optionId = z.string().uuid().parse(req.body?.optionId);
      const poll = await prisma.poll.findUnique({
        where: { id: String(req.params.id) },
        include: { options: true },
      });
      if (!poll) {
        res.status(404).json({ error: 'Encuesta no encontrada.' });
        return;
      }
      if (poll.isClosed || (poll.endsAt && poll.endsAt < new Date())) {
        res.status(400).json({ error: 'Esta encuesta ya está cerrada.' });
        return;
      }
      if (!poll.options.some((o) => o.id === optionId)) {
        res.status(400).json({ error: 'Opción inválida.' });
        return;
      }

      const userId = req.user!.id;
      const existingSameOption = await prisma.pollVote.findUnique({
        where: { pollId_optionId_userId: { pollId: poll.id, optionId, userId } },
      });

      if (poll.allowMultiple) {
        if (existingSameOption) {
          await prisma.pollVote.delete({ where: { id: existingSameOption.id } });
        } else {
          await prisma.pollVote.create({ data: { pollId: poll.id, optionId, userId } });
        }
      } else {
        await prisma.$transaction([
          prisma.pollVote.deleteMany({ where: { pollId: poll.id, userId } }),
          prisma.pollVote.create({ data: { pollId: poll.id, optionId, userId } }),
        ]);
      }

      const formatted = await formatPoll(poll.id, userId);
      emitToAll('poll:updated', { poll: formatted });
      res.json({ poll: formatted });
    } catch (err) {
      next(err);
    }
  }
);

pollsRouter.patch('/:id', requireStaff, async (req, res, next) => {
  try {
    const schema = z.object({
      isClosed: z.boolean().optional(),
      question: z.string().min(4).max(250).optional(),
      description: z.string().max(500).nullable().optional(),
    });
    const data = schema.parse(req.body);
    const pollId = String(req.params.id);
    await prisma.poll.update({
      where: { id: pollId },
      data,
    });
    const formatted = await formatPoll(pollId, req.user!.id);
    emitToAll('poll:updated', { poll: formatted });
    res.json({ poll: formatted });
  } catch (err) {
    next(err);
  }
});

pollsRouter.delete('/:id', requireStaff, async (req, res, next) => {
  try {
    const pollId = String(req.params.id);
    await prisma.poll.delete({ where: { id: pollId } });
    emitToAll('poll:deleted', { pollId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
