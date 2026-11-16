import { Router } from 'express';
import { z } from 'zod';
import { PostStatus, ReactionType, TopicType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { checkCooldownRemaining, checkTextModeration } from '../../lib/moderation';
import { dispatchNotifications } from '../../lib/notifications';
import { getRestrictedWordsList, getSystemSettings, isStaffRole } from '../../lib/settings';
import { emitToAll } from '../../lib/socket';
import { requireAuth, requireNotMuted, requireStaff } from '../../middleware/auth.middleware';
import { requireFeatureEnabled } from '../../middleware/feature.middleware';

export const postsRouter = Router();

const createPostSchema = z.object({
  topic: z.nativeEnum(TopicType),
  subType: z.string().min(1).max(40).default('GENERAL'),
  title: z.string().min(2).max(220),
  content: z.string().min(1).max(15000),
  images: z.array(z.string().max(1000)).max(10).default([]),
  tags: z.array(z.string().max(50)).max(15).default([]),
  metadata: z.record(z.unknown()).nullable().optional(),
  status: z.nativeEnum(PostStatus).optional(),
  isPinned: z.boolean().optional(),
  allowComments: z.boolean().optional(),
  matchId: z.string().uuid().nullable().optional(),
});

const updatePostSchema = createPostSchema.partial();

const TOPIC_TITLES: Record<TopicType, string> = {
  FOOTBALL: 'Fútbol',
  STREAMING: 'Streaming',
  NEWS: 'Noticias',
  TV_CHANNELS: 'Canales de TV',
};

function formatPostForUser(
  post: {
    reactions: Array<{ type: ReactionType; userId: string }>;
    ratings: Array<{ score: number; userId: string }>;
    _count?: { comments?: number; reactions?: number; ratings?: number };
    [key: string]: unknown;
  },
  currentUserId: string
) {
  const reactionCounts: Record<ReactionType, number> = {
    LIKE: 0,
    LOVE: 0,
    FIRE: 0,
    STAR: 0,
    CLAP: 0,
  };
  let userReaction: ReactionType | null = null;
  for (const r of post.reactions) {
    reactionCounts[r.type] = (reactionCounts[r.type] || 0) + 1;
    if (r.userId === currentUserId) {
      userReaction = r.type;
    }
  }

  let totalScore = 0;
  let userRating: number | null = null;
  for (const rt of post.ratings) {
    totalScore += rt.score;
    if (rt.userId === currentUserId) {
      userRating = rt.score;
    }
  }
  const ratingCount = post.ratings.length;
  const avgRating = ratingCount > 0 ? Number((totalScore / ratingCount).toFixed(1)) : 0;

  const { reactions: _r, ratings: _rt, ...rest } = post;
  return {
    ...rest,
    reactionSummary: {
      total: post.reactions.length,
      counts: reactionCounts,
      userReaction,
    },
    ratingSummary: {
      average: avgRating,
      count: ratingCount,
      userRating,
    },
    commentCount: post._count?.comments ?? 0,
  };
}

postsRouter.use(requireAuth);

postsRouter.get('/radar', async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lastVisitAt: true, role: true },
    });

    const settings = await getSystemSettings();
    const since = user.lastVisitAt;

    const [
      newByTopicRows,
      liveMatches,
      upcomingMatches,
      openPolls,
      votedPolls,
      openGiveaways,
      unreadNotifications,
    ] = await Promise.all([
      prisma.post.groupBy({
        by: ['topic'],
        where: {
          status: 'APPROVED',
          createdAt: { gt: since },
        },
        _count: { id: true },
      }),
      prisma.match.findMany({
        where: { status: { in: ['LIVE', 'HALFTIME'] } },
        include: {
          league: { select: { id: true, name: true, shortName: true } },
          homeTeam: true,
          awayTeam: true,
        },
        orderBy: { matchDate: 'desc' },
        take: 5,
      }),
      prisma.match.findMany({
        where: {
          status: 'UPCOMING',
          matchDate: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        include: {
          league: { select: { id: true, name: true, shortName: true } },
          homeTeam: true,
          awayTeam: true,
        },
        orderBy: { matchDate: 'asc' },
        take: 4,
      }),
      prisma.poll.findMany({
        where: { isClosed: false },
        select: { id: true },
      }),
      prisma.pollVote.findMany({
        where: { userId },
        select: { pollId: true },
        distinct: ['pollId'],
      }),
      prisma.giveaway.findMany({
        where: { status: { in: ['OPEN', 'DRAWING'] } },
        include: {
          entries: { where: { userId }, select: { id: true } },
          _count: { select: { entries: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 3,
      }),
      prisma.notification.count({
        where: { userId, isRead: false },
      }),
    ]);

    const newByTopic: Record<TopicType, number> = {
      FOOTBALL: 0,
      STREAMING: 0,
      NEWS: 0,
      TV_CHANNELS: 0,
    };
    for (const row of newByTopicRows) {
      newByTopic[row.topic] = row._count.id;
    }

    const votedSet = new Set(votedPolls.map((v) => v.pollId));
    const pendingPollsCount = openPolls.filter((p) => !votedSet.has(p.id)).length;

    const isStaff = isStaffRole(user.role);
    const unreadInboxCount = isStaff
      ? (await prisma.directThread.aggregate({ _sum: { unreadForAdmin: true } }))._sum.unreadForAdmin || 0
      : (await prisma.directThread.aggregate({ where: { userId }, _sum: { unreadForUser: true } }))._sum.unreadForUser || 0;

    res.json({
      since,
      totalNewPosts: Object.values(newByTopic).reduce((acc, n) => acc + n, 0),
      newByTopic,
      liveMatches,
      upcomingMatches,
      pendingPollsCount,
      openGiveaways: openGiveaways.map((g) => ({
        id: g.id,
        title: g.title,
        prizeDescription: g.prizeDescription,
        scheduledAt: g.scheduledAt,
        status: g.status,
        entriesCount: g._count.entries,
        isEnrolled: g.entries.length > 0,
      })),
      unreadNotifications,
      unreadInboxCount,
      settings,
    });
  } catch (err) {
    next(err);
  }
});

postsRouter.get('/tags', async (req, res, next) => {
  try {
    const topic = typeof req.query.topic === 'string' && Object.values(TopicType).includes(req.query.topic as TopicType)
      ? (req.query.topic as TopicType)
      : undefined;
    const posts = await prisma.post.findMany({
      where: {
        status: PostStatus.APPROVED,
        ...(topic ? { topic } : {}),
      },
      select: { tags: true },
      take: 100,
    });
    const counts: Record<string, number> = {};
    for (const p of posts) {
      if (Array.isArray(p.tags)) {
        for (const t of p.tags) {
          const clean = t.trim().toLowerCase();
          if (clean) {
            counts[clean] = (counts[clean] || 0) + 1;
          }
        }
      }
    }
    const tags = Object.entries(counts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

postsRouter.get('/', async (req, res, next) => {
  try {
    const topicParam = typeof req.query.topic === 'string' ? req.query.topic : undefined;
    const subTypeParam = typeof req.query.subType === 'string' ? req.query.subType.trim() : undefined;
    const tagParam = typeof req.query.tag === 'string' ? req.query.tag.trim().toLowerCase() : undefined;
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const isStaff = isStaffRole(req.user!.role);

    const where: Record<string, unknown> = {};
    if (topicParam && Object.values(TopicType).includes(topicParam as TopicType)) {
      where.topic = topicParam;
    }
    if (subTypeParam && subTypeParam !== 'ALL') {
      where.subType = subTypeParam;
    }
    if (tagParam && tagParam !== 'all') {
      where.tags = { has: tagParam };
    }
    if (isStaff && statusParam && Object.values(PostStatus).includes(statusParam as PostStatus)) {
      where.status = statusParam;
    } else if (!isStaff || !statusParam) {
      where.status = isStaff && statusParam === 'ALL' ? undefined : PostStatus.APPROVED;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
        { tags: { has: search.toLowerCase() } },
      ];
    }

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true,
            },
          },
          match: {
            include: {
              league: { select: { id: true, name: true, shortName: true, logoUrl: true } },
              homeTeam: true,
              awayTeam: true,
            },
          },
          reactions: { select: { type: true, userId: true } },
          ratings: { select: { score: true, userId: true } },
          _count: {
            select: {
              comments: { where: { isHidden: false } },
            },
          },
        },
      }),
    ]);

    res.json({
      posts: posts.map((p) => formatPostForUser(p, req.user!.id)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

postsRouter.get('/:id', async (req, res, next) => {
  try {
    const isStaff = isStaffRole(req.user!.role);
    const post = await prisma.post.findUnique({
      where: { id: req.params.id },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            role: true,
          },
        },
        match: {
          include: {
            league: true,
            homeTeam: true,
            awayTeam: true,
          },
        },
        reactions: { select: { type: true, userId: true } },
        ratings: { select: { score: true, userId: true } },
        comments: {
          where: isStaff ? { parentId: null } : { isHidden: false, parentId: null },
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                role: true,
              },
            },
            replies: {
              where: isStaff ? undefined : { isHidden: false },
              orderBy: { createdAt: 'asc' },
              include: {
                author: {
                  select: {
                    id: true,
                    username: true,
                    displayName: true,
                    avatarUrl: true,
                    role: true,
                  },
                },
              },
            },
          },
        },
        _count: {
          select: {
            comments: { where: { isHidden: false } },
          },
        },
      },
    });

    if (!post || (post.status !== PostStatus.APPROVED && !isStaff)) {
      res.status(404).json({ error: 'Publicación no encontrada.' });
      return;
    }

    res.json({ post: formatPostForUser(post, req.user!.id) });
  } catch (err) {
    next(err);
  }
});

postsRouter.post('/', requireStaff, async (req, res, next) => {
  try {
    const data = createPostSchema.parse(req.body);
    const created = await prisma.post.create({
      data: {
        topic: data.topic,
        subType: data.subType,
        title: data.title.trim(),
        content: data.content.trim(),
        images: data.images,
        tags: data.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
        metadata: (data.metadata ?? undefined) as object | undefined,
        status: data.status ?? PostStatus.APPROVED,
        isPinned: data.isPinned ?? false,
        allowComments: data.allowComments ?? true,
        matchId: data.matchId ?? null,
        authorId: req.user!.id,
      },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
        },
        match: {
          include: { league: true, homeTeam: true, awayTeam: true },
        },
        reactions: { select: { type: true, userId: true } },
        ratings: { select: { score: true, userId: true } },
        _count: { select: { comments: true } },
      },
    });

    const formatted = formatPostForUser(created, req.user!.id);

    if (created.status === PostStatus.APPROVED) {
      emitToAll('post:new', { post: formatted });
      void dispatchNotifications({
        type: created.topic === 'FOOTBALL' && created.matchId ? 'MATCH_UPDATE' : 'NEW_POST',
        title: `Nuevo en ${TOPIC_TITLES[created.topic]}`,
        body: created.title,
        topic: created.topic,
        referenceId: created.id,
        referenceType: 'POST',
        excludeUserId: req.user!.id,
      });
    }

    res.status(201).json({ post: formatted });
  } catch (err) {
    next(err);
  }
});

postsRouter.patch('/:id', requireStaff, async (req, res, next) => {
  try {
    const postId = String(req.params.id);
    const data = updatePostSchema.parse(req.body);
    const prev = await prisma.post.findUnique({ where: { id: postId } });
    if (!prev) {
      res.status(404).json({ error: 'Publicación no encontrada.' });
      return;
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data: {
        ...data,
        metadata: data.metadata === undefined ? undefined : ((data.metadata ?? null) as object),
      },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
        },
        match: { include: { league: true, homeTeam: true, awayTeam: true } },
        reactions: { select: { type: true, userId: true } },
        ratings: { select: { score: true, userId: true } },
        _count: { select: { comments: { where: { isHidden: false } } } },
      },
    });

    const formatted = formatPostForUser(updated, req.user!.id);
    emitToAll('post:updated', { post: formatted });

    if (prev.status !== PostStatus.APPROVED && updated.status === PostStatus.APPROVED) {
      void dispatchNotifications({
        type: 'NEW_POST',
        title: `Publicado en ${TOPIC_TITLES[updated.topic]}`,
        body: updated.title,
        topic: updated.topic,
        referenceId: updated.id,
        referenceType: 'POST',
      });
    }

    res.json({ post: formatted });
  } catch (err) {
    next(err);
  }
});

postsRouter.delete('/:id', requireStaff, async (req, res, next) => {
  try {
    const postId = String(req.params.id);
    await prisma.post.delete({ where: { id: postId } });
    emitToAll('post:deleted', { postId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

postsRouter.post(
  '/:id/react',
  requireFeatureEnabled('likesEnabled'),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const type = z.nativeEnum(ReactionType).parse(req.body?.type ?? 'LIKE');
      const postId = String(req.params.id);
      const userId = req.user!.id;

      const existing = await prisma.reaction.findUnique({
        where: { postId_userId: { postId, userId } },
      });

      let action: 'added' | 'removed' | 'updated' = 'added';
      if (existing) {
        if (existing.type === type) {
          await prisma.reaction.delete({ where: { id: existing.id } });
          action = 'removed';
        } else {
          await prisma.reaction.update({ where: { id: existing.id }, data: { type } });
          action = 'updated';
        }
      } else {
        await prisma.reaction.create({ data: { postId, userId, type } });
      }

      const allReactions = await prisma.reaction.findMany({
        where: { postId },
        select: { type: true, userId: true },
      });

      const counts: Record<ReactionType, number> = {
        LIKE: 0,
        LOVE: 0,
        FIRE: 0,
        STAR: 0,
        CLAP: 0,
      };
      for (const r of allReactions) {
        counts[r.type] = (counts[r.type] || 0) + 1;
      }

      const payload = {
        postId,
        action,
        total: allReactions.length,
        counts,
        userReaction: action === 'removed' ? null : type,
      };
      emitToAll('post:reaction', { postId, total: allReactions.length, counts });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

postsRouter.post(
  '/:id/rate',
  requireFeatureEnabled('ratingsEnabled'),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const score = z.number().int().min(1).max(5).parse(Number(req.body?.score));
      const postId = String(req.params.id);
      const userId = req.user!.id;

      await prisma.rating.upsert({
        where: { postId_userId: { postId, userId } },
        update: { score },
        create: { postId, userId, score },
      });

      const allRatings = await prisma.rating.findMany({
        where: { postId },
        select: { score: true },
      });
      const count = allRatings.length;
      const average =
        count > 0
          ? Number((allRatings.reduce((acc, r) => acc + r.score, 0) / count).toFixed(1))
          : 0;

      emitToAll('post:rating', { postId, average, count });
      res.json({ postId, average, count, userRating: score });
    } catch (err) {
      next(err);
    }
  }
);

postsRouter.post(
  '/:id/comments',
  requireFeatureEnabled('commentsEnabled'),
  requireNotMuted,
  async (req, res, next) => {
    try {
      const postId = String(req.params.id);
      const post = await prisma.post.findUnique({ where: { id: postId } });
      if (!post || post.status !== PostStatus.APPROVED) {
        res.status(404).json({ error: 'Publicación no encontrada.' });
        return;
      }
      if (!post.allowComments && !isStaffRole(req.user!.role)) {
        res.status(403).json({ error: 'Los comentarios están cerrados en esta publicación.' });
        return;
      }

      const settings = await getSystemSettings();
      const restrictedWords = await getRestrictedWordsList();
      const isStaff = isStaffRole(req.user!.role);

      if (!isStaff && settings.commentCooldownSec > 0) {
        const lastComment = await prisma.comment.findFirst({
          where: { authorId: req.user!.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        const waitSec = checkCooldownRemaining(lastComment?.createdAt, settings.commentCooldownSec);
        if (waitSec > 0) {
          res.status(429).json({
            error: `Esperá ${waitSec}s antes de volver a comentar.`,
          });
          return;
        }
      }

      const rawContent = typeof req.body?.content === 'string' ? req.body.content : '';
      const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId : null;

      const check = checkTextModeration(rawContent, {
        maxLength: settings.maxCommentLength,
        blockLinks: isStaff ? false : settings.blockLinksInComments,
        restrictedWords,
      });

      if (!check.ok) {
        res.status(400).json({ error: check.reason });
        return;
      }

      const created = await prisma.comment.create({
        data: {
          content: check.sanitized,
          postId,
          authorId: req.user!.id,
          parentId,
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              role: true,
            },
          },
          replies: true,
        },
      });

      emitToAll('post:comment', { postId, comment: created });
      res.status(201).json({ comment: created });
    } catch (err) {
      next(err);
    }
  }
);

postsRouter.delete('/:postId/comments/:commentId', async (req, res, next) => {
  try {
    const comment = await prisma.comment.findUnique({
      where: { id: String(req.params.commentId) },
    });
    if (!comment || comment.postId !== String(req.params.postId)) {
      res.status(404).json({ error: 'Comentario no encontrado.' });
      return;
    }

    const isOwner = comment.authorId === req.user!.id;
    const isStaff = isStaffRole(req.user!.role);
    if (!isOwner && !isStaff) {
      res.status(403).json({ error: 'No tenés permiso para borrar este comentario.' });
      return;
    }

    await prisma.comment.delete({ where: { id: comment.id } });
    emitToAll('post:comment_deleted', { postId: comment.postId, commentId: comment.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
