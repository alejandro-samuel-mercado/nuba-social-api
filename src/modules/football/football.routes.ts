import { Router } from 'express';
import { z } from 'zod';
import { FeatureVisualMode, MatchStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { dispatchNotifications } from '../../lib/notifications';
import { emitToAll } from '../../lib/socket';
import { requireAdmin, requireAuth, requireStaff } from '../../middleware/auth.middleware';

export const footballRouter = Router();

export interface StandingsTeamInput {
  id: string;
  name: string;
}

export interface FinishedMatchInput {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
}

export interface ComputedStandingRow {
  teamId: string;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  position: number;
}

/**
 * Calcula y ordena la tabla de posiciones de una liga a partir de los partidos finalizados.
 */
export function computeLeagueStandings(
  teams: StandingsTeamInput[],
  finishedMatches: FinishedMatchInput[]
): ComputedStandingRow[] {
  const map = new Map<string, ComputedStandingRow>();

  for (const t of teams) {
    map.set(t.id, {
      teamId: t.id,
      teamName: t.name,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDiff: 0,
      points: 0,
      position: 0,
    });
  }

  for (const m of finishedMatches) {
    const home = map.get(m.homeTeamId);
    const away = map.get(m.awayTeamId);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.goalsFor += m.homeScore;
    home.goalsAgainst += m.awayScore;
    away.goalsFor += m.awayScore;
    away.goalsAgainst += m.homeScore;

    if (m.homeScore > m.awayScore) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (m.homeScore < m.awayScore) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  }

  const rows = Array.from(map.values()).map((r) => ({
    ...r,
    goalDiff: r.goalsFor - r.goalsAgainst,
  }));

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return a.teamName.localeCompare(b.teamName);
  });

  return rows.map((r, index) => ({ ...r, position: index + 1 }));
}

async function syncLeagueStandings(leagueId: string) {
  const [leagueTeams, finishedMatches] = await Promise.all([
    prisma.team.findMany({
      where: {
        OR: [
          { leagueId },
          { homeMatches: { some: { leagueId } } },
          { awayMatches: { some: { leagueId } } },
          { standings: { some: { leagueId } } },
        ],
      },
      select: { id: true, name: true },
    }),
    prisma.match.findMany({
      where: { leagueId, status: MatchStatus.FINISHED },
      select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true },
    }),
  ]);

  const computed = computeLeagueStandings(leagueTeams, finishedMatches);

  await Promise.all(
    computed.map((row) =>
      prisma.standing.upsert({
        where: { leagueId_teamId: { leagueId, teamId: row.teamId } },
        update: {
          played: row.played,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          goalsFor: row.goalsFor,
          goalsAgainst: row.goalsAgainst,
          goalDiff: row.goalDiff,
          points: row.points,
          position: row.position,
        },
        create: {
          leagueId,
          teamId: row.teamId,
          played: row.played,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          goalsFor: row.goalsFor,
          goalsAgainst: row.goalsAgainst,
          goalDiff: row.goalDiff,
          points: row.points,
          position: row.position,
        },
      })
    )
  );

  emitToAll('standings:updated', { leagueId });
  return computed;
}

const leagueSchema = z.object({
  name: z.string().min(2).max(120),
  shortName: z.string().max(20).nullable().optional(),
  country: z.string().max(60).default('Internacional'),
  season: z.string().max(20).default('2026'),
  logoUrl: z.string().max(500).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

const teamSchema = z.object({
  name: z.string().min(2).max(100),
  shortName: z.string().min(2).max(8),
  logoUrl: z.string().max(500).nullable().optional(),
  stadium: z.string().max(120).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  country: z.string().max(60).nullable().optional(),
  colorPrimary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#F9E4A0'),
  colorSecondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2D2D2D'),
  leagueId: z.string().uuid().nullable().optional(),
});

const matchSchema = z.object({
  leagueId: z.string().uuid(),
  homeTeamId: z.string().uuid(),
  awayTeamId: z.string().uuid(),
  matchDate: z.string().datetime().or(z.string().min(8)),
  matchday: z.string().max(60).nullable().optional(),
  stadium: z.string().max(120).nullable().optional(),
  location: z.string().max(120).nullable().optional(),
  broadcastInfo: z.string().max(160).nullable().optional(),
  status: z.nativeEnum(MatchStatus).default(MatchStatus.UPCOMING),
  homeScore: z.number().int().min(0).default(0),
  awayScore: z.number().int().min(0).default(0),
  featureMode: z.nativeEnum(FeatureVisualMode).default(FeatureVisualMode.AUTO),
  featureImageUrl: z.string().max(500).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  publishPost: z.boolean().default(true),
  postTitle: z.string().max(220).optional(),
  postContent: z.string().max(3000).optional(),
});

const standingsBulkSchema = z.object({
  rows: z.array(
    z.object({
      teamId: z.string().uuid(),
      played: z.number().int().min(0),
      won: z.number().int().min(0),
      drawn: z.number().int().min(0),
      lost: z.number().int().min(0),
      goalsFor: z.number().int().min(0),
      goalsAgainst: z.number().int().min(0),
      points: z.number().int().min(0),
      position: z.number().int().min(1),
    })
  ),
});

footballRouter.use(requireAuth);

// ─── LIGAS / TORNEOS ──────────────────────────────────────────────────────────

footballRouter.get('/leagues', async (_req, res, next) => {
  try {
    const leagues = await prisma.league.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: {
        _count: {
          select: { teams: true, matches: true, standings: true },
        },
      },
    });
    res.json({ leagues });
  } catch (err) {
    next(err);
  }
});

footballRouter.post('/leagues', requireStaff, async (req, res, next) => {
  try {
    const data = leagueSchema.parse(req.body);
    const league = await prisma.league.create({ data });
    res.status(201).json({ league });
  } catch (err) {
    next(err);
  }
});

footballRouter.patch('/leagues/:id', requireStaff, async (req, res, next) => {
  try {
    const data = leagueSchema.partial().parse(req.body);
    const league = await prisma.league.update({
      where: { id: String(req.params.id) },
      data,
    });
    res.json({ league });
  } catch (err) {
    next(err);
  }
});

footballRouter.delete('/leagues/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.league.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── EQUIPOS ──────────────────────────────────────────────────────────────────

footballRouter.get('/teams', async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const leagueId = typeof req.query.leagueId === 'string' ? req.query.leagueId : undefined;

    const teams = await prisma.team.findMany({
      where: {
        ...(leagueId ? { leagueId } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { shortName: { contains: search, mode: 'insensitive' } },
                { city: { contains: search, mode: 'insensitive' } },
                { stadium: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        league: { select: { id: true, name: true, shortName: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ teams });
  } catch (err) {
    next(err);
  }
});

footballRouter.post('/teams', requireStaff, async (req, res, next) => {
  try {
    const data = teamSchema.parse(req.body);
    const team = await prisma.team.create({
      data: {
        ...data,
        shortName: data.shortName.toUpperCase(),
      },
      include: {
        league: { select: { id: true, name: true, shortName: true } },
      },
    });

    if (team.leagueId) {
      await syncLeagueStandings(team.leagueId);
    }

    res.status(201).json({ team });
  } catch (err) {
    next(err);
  }
});

footballRouter.patch('/teams/:id', requireStaff, async (req, res, next) => {
  try {
    const data = teamSchema.partial().parse(req.body);
    const team = await prisma.team.update({
      where: { id: String(req.params.id) },
      data: {
        ...data,
        shortName: data.shortName ? data.shortName.toUpperCase() : undefined,
      },
      include: {
        league: { select: { id: true, name: true, shortName: true } },
      },
    });
    if (team.leagueId) {
      await syncLeagueStandings(team.leagueId);
    }
    res.json({ team });
  } catch (err) {
    next(err);
  }
});

footballRouter.delete('/teams/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.team.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── PARTIDOS & FEATURES ──────────────────────────────────────────────────────

footballRouter.get('/matches', async (req, res, next) => {
  try {
    const leagueId = typeof req.query.leagueId === 'string' ? req.query.leagueId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const sort = req.query.sort === 'upcoming' ? 'asc' : 'desc';

    const matches = await prisma.match.findMany({
      where: {
        ...(leagueId ? { leagueId } : {}),
        ...(status && Object.values(MatchStatus).includes(status as MatchStatus)
          ? { status: status as MatchStatus }
          : {}),
      },
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
        post: { select: { id: true, title: true, status: true } },
      },
      orderBy: [{ matchDate: sort }, { createdAt: 'desc' }],
      take: 80,
    });
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

footballRouter.post('/matches', requireStaff, async (req, res, next) => {
  try {
    const data = matchSchema.parse(req.body);
    if (data.homeTeamId === data.awayTeamId) {
      res.status(400).json({ error: 'El equipo local y visitante no pueden ser el mismo.' });
      return;
    }

    const [homeTeam, awayTeam, league] = await Promise.all([
      prisma.team.findUniqueOrThrow({ where: { id: data.homeTeamId } }),
      prisma.team.findUniqueOrThrow({ where: { id: data.awayTeamId } }),
      prisma.league.findUniqueOrThrow({ where: { id: data.leagueId } }),
    ]);

    const stadium = data.stadium || homeTeam.stadium || null;
    const location = data.location || homeTeam.city || league.country || null;

    const match = await prisma.match.create({
      data: {
        leagueId: data.leagueId,
        homeTeamId: data.homeTeamId,
        awayTeamId: data.awayTeamId,
        matchDate: new Date(data.matchDate),
        matchday: data.matchday ?? null,
        stadium,
        location,
        broadcastInfo: data.broadcastInfo ?? null,
        status: data.status,
        homeScore: data.homeScore,
        awayScore: data.awayScore,
        featureMode: data.featureMode,
        featureImageUrl: data.featureImageUrl ?? null,
        notes: data.notes ?? null,
      },
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
      },
    });

    let post = null;
    if (data.publishPost) {
      const defaultTitle =
        data.postTitle?.trim() || `${homeTeam.name} vs ${awayTeam.name} • ${league.shortName || league.name}`;
      const defaultContent =
        data.postContent?.trim() ||
        `Partido confirmado${data.matchday ? ` (${data.matchday})` : ''} en ${stadium || 'estadio a confirmar'}${
          data.broadcastInfo ? `. Transmisión: ${data.broadcastInfo}` : ''
        }.`;

      post = await prisma.post.create({
        data: {
          topic: 'FOOTBALL',
          subType: 'MATCH_FEATURE',
          title: defaultTitle,
          content: defaultContent,
          images: data.featureMode === 'CUSTOM_IMAGE' && data.featureImageUrl ? [data.featureImageUrl] : [],
          tags: [
            league.shortName?.toLowerCase() || 'futbol',
            homeTeam.shortName.toLowerCase(),
            awayTeam.shortName.toLowerCase(),
          ],
          status: 'APPROVED',
          matchId: match.id,
          authorId: req.user!.id,
        },
        include: {
          author: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
          },
          match: { include: { league: true, homeTeam: true, awayTeam: true } },
          reactions: { select: { type: true, userId: true } },
          ratings: { select: { score: true, userId: true } },
          _count: { select: { comments: true } },
        },
      });

      emitToAll('post:new', { post });
      void dispatchNotifications({
        type: 'MATCH_UPDATE',
        title: `⚽ Nuevo partido: ${homeTeam.shortName} vs ${awayTeam.shortName}`,
        body: `${league.name}${stadium ? ` • ${stadium}` : ''}`,
        topic: 'FOOTBALL',
        referenceId: post.id,
        referenceType: 'POST',
        excludeUserId: req.user!.id,
      });
    }

    if (match.status === MatchStatus.FINISHED) {
      await syncLeagueStandings(match.leagueId);
    }

    emitToAll('match:new', { match });
    res.status(201).json({ match, post });
  } catch (err) {
    next(err);
  }
});

footballRouter.patch('/matches/:id', requireStaff, async (req, res, next) => {
  try {
    const partial = matchSchema.partial().parse(req.body);
    const { publishPost: _pp, postTitle: _pt, postContent: _pc, ...matchFields } = partial;

    const updated = await prisma.match.update({
      where: { id: String(req.params.id) },
      data: {
        ...matchFields,
        matchDate: matchFields.matchDate ? new Date(matchFields.matchDate) : undefined,
      },
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
        post: { select: { id: true } },
      },
    });

    if (updated.status === MatchStatus.FINISHED) {
      await syncLeagueStandings(updated.leagueId);
    }

    emitToAll('match:updated', { match: updated });
    res.json({ match: updated });
  } catch (err) {
    next(err);
  }
});

footballRouter.delete('/matches/:id', requireStaff, async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({ where: { id: String(req.params.id) } });
    if (!match) {
      res.status(404).json({ error: 'Partido no encontrado.' });
      return;
    }
    await prisma.match.delete({ where: { id: match.id } });
    await syncLeagueStandings(match.leagueId);
    emitToAll('match:deleted', { matchId: match.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── TABLA DE POSICIONES ──────────────────────────────────────────────────────

footballRouter.get('/standings/:leagueId', async (req, res, next) => {
  try {
    const leagueId = String(req.params.leagueId);
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
    });
    if (!league) {
      res.status(404).json({ error: 'Liga no encontrada.' });
      return;
    }

    const standings = await prisma.standing.findMany({
      where: { leagueId: league.id },
      include: { team: true },
      orderBy: [{ position: 'asc' }, { points: 'desc' }, { goalDiff: 'desc' }],
    });

    res.json({ league, standings });
  } catch (err) {
    next(err);
  }
});

footballRouter.post('/standings/:leagueId/recalculate', requireStaff, async (req, res, next) => {
  try {
    const leagueId = String(req.params.leagueId);
    await syncLeagueStandings(leagueId);
    const standings = await prisma.standing.findMany({
      where: { leagueId },
      include: { team: true },
      orderBy: [{ position: 'asc' }],
    });
    res.json({ standings });
  } catch (err) {
    next(err);
  }
});

footballRouter.put('/standings/:leagueId', requireStaff, async (req, res, next) => {
  try {
    const { rows } = standingsBulkSchema.parse(req.body);
    const leagueId = String(req.params.leagueId);

    await Promise.all(
      rows.map((row) =>
        prisma.standing.upsert({
          where: { leagueId_teamId: { leagueId, teamId: row.teamId } },
          update: {
            played: row.played,
            won: row.won,
            drawn: row.drawn,
            lost: row.lost,
            goalsFor: row.goalsFor,
            goalsAgainst: row.goalsAgainst,
            goalDiff: row.goalsFor - row.goalsAgainst,
            points: row.points,
            position: row.position,
          },
          create: {
            leagueId,
            teamId: row.teamId,
            played: row.played,
            won: row.won,
            drawn: row.drawn,
            lost: row.lost,
            goalsFor: row.goalsFor,
            goalsAgainst: row.goalsAgainst,
            goalDiff: row.goalsFor - row.goalsAgainst,
            points: row.points,
            position: row.position,
          },
        })
      )
    );

    emitToAll('standings:updated', { leagueId });
    const standings = await prisma.standing.findMany({
      where: { leagueId },
      include: { team: true },
      orderBy: [{ position: 'asc' }],
    });
    res.json({ standings });
  } catch (err) {
    next(err);
  }
});
