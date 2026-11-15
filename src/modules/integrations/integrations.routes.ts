import { Router, type Request, type Response, type NextFunction } from 'express';
import axios from 'axios';
import { requireAuth, requireStaff } from '../../middleware/auth.middleware';

export const integrationsRouter = Router();

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';

function extractList<T = unknown>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.results)) return obj.results as T[];
  }
  return [];
}

function getStreamFlexBase(): string {
  return (process.env.STREAMFLEX_API_URL || 'https://api-streamflex.unixxtech.online/api').replace(
    /\/+$/,
    ''
  );
}

function getNexoPlayBase(): string {
  return (process.env.NEXOPLAY_API_URL || 'https://nexoplay-api.unixxtech.online/api').replace(
    /\/+$/,
    ''
  );
}

function getNubaTvBase(): string {
  return (process.env.NUBATV_API_URL || 'https://nubatv-api.unixxtech.online/api').replace(
    /\/+$/,
    ''
  );
}

interface RawExternalContentItem {
  id: string;
  tmdbId?: number | null;
  type?: string;
  subType?: string;
  status?: string;
  slug?: string;
  releaseYear?: number | null;
  duration?: number | null;
  rating?: number | null;
  country?: string | null;
  originalTitle?: string | null;
  trailerUrl?: string | null;
  title?: string;
  synopsis?: string;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  translations?: Array<{
    language: string;
    title?: string;
    description?: string;
    tagline?: string;
  }>;
  thumbnails?: Array<{ type: string; url: string }>;
  genres?: Array<{ genre?: { name?: string }; name?: string }>;
  platform?: string | null;
  createdAt?: string;
}

export function normalizeExternalStreamingItem(
  item: RawExternalContentItem,
  source: 'streamflex' | 'nexoplay' = 'streamflex'
) {
  const esTrans =
    item.translations?.find((t) => t.language?.toLowerCase().startsWith('es')) ||
    item.translations?.[0];

  const posterThumb = item.thumbnails?.find((t) => t.type === 'POSTER')?.url;
  const backdropThumb = item.thumbnails?.find((t) => t.type === 'BACKDROP')?.url;

  const genres = (item.genres || [])
    .map((g) => g.genre?.name || g.name || '')
    .filter(Boolean);

  return {
    source,
    externalId: item.id,
    tmdbId: item.tmdbId ?? null,
    mediaType: item.type || 'MOVIE',
    title: esTrans?.title || item.title || item.originalTitle || 'Sin título',
    originalTitle: item.originalTitle || null,
    tagline: esTrans?.tagline || null,
    synopsis: esTrans?.description || item.synopsis || item.overview || '',
    posterUrl: posterThumb || item.posterUrl || null,
    backdropUrl: backdropThumb || item.backdropUrl || null,
    releaseYear: item.releaseYear ?? null,
    duration: item.duration ?? null,
    rating: item.rating ?? null,
    country: item.country ?? null,
    trailerUrl: item.trailerUrl ?? null,
    platform: item.platform ?? (source === 'streamflex' ? 'StreamFlex' : 'NexoPlay'),
    genres,
    createdAt: item.createdAt ?? null,
  };
}

async function fetchTmdbDetails(tmdbId: number, isTv: boolean) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const endpoint = isTv ? `tv/${tmdbId}` : `movie/${tmdbId}`;
  const { data } = await axios.get(`${TMDB_BASE}/${endpoint}`, {
    params: {
      api_key: apiKey,
      language: 'es-MX',
      append_to_response: 'credits,videos',
    },
    timeout: 7000,
  });

  const trailer = (data.videos?.results || []).find(
    (v: { site?: string; type?: string }) =>
      v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')
  );

  return {
    tmdbId: data.id,
    title: isTv ? data.name : data.title,
    originalTitle: isTv ? data.original_name : data.original_title,
    tagline: data.tagline || null,
    synopsis: data.overview || '',
    posterUrl: data.poster_path ? `${TMDB_IMG}/w500${data.poster_path}` : null,
    backdropUrl: data.backdrop_path ? `${TMDB_IMG}/w1280${data.backdrop_path}` : null,
    releaseYear: (() => {
      const d = isTv ? data.first_air_date : data.release_date;
      return d ? Number(String(d).slice(0, 4)) : null;
    })(),
    duration: isTv ? data.episode_run_time?.[0] ?? null : data.runtime ?? null,
    seasonsCount: isTv ? data.number_of_seasons ?? null : null,
    rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
    genres: (data.genres || []).map((g: { name: string }) => g.name),
    cast: (data.credits?.cast || [])
      .slice(0, 6)
      .map((c: { name: string; character?: string }) => ({
        name: c.name,
        character: c.character || '',
      })),
    trailerUrl: trailer?.key ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
  };
}

integrationsRouter.use(requireAuth, requireStaff);

// ─── STREAMFLEX + NEXOPLAY + TMDB ─────────────────────────────────────────────

integrationsRouter.get('/streamflex/content', async (req, res, next) => {
  try {
    const source = req.query.source === 'nexoplay' ? 'nexoplay' : 'streamflex';
    const base = source === 'nexoplay' ? getNexoPlayBase() : getStreamFlexBase();
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 20, 48);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const type = typeof req.query.type === 'string' && req.query.type !== 'ALL' ? req.query.type : undefined;

    const { data } = await axios.get(`${base}/content`, {
      params: { page, limit, search, type },
      timeout: 8000,
    });

    const rawItems = extractList<RawExternalContentItem>(data);
    res.json({
      source,
      items: rawItems.map((item) => normalizeExternalStreamingItem(item, source)),
      meta: data?.meta || { page, limit, total: rawItems.length, totalPages: 1 },
    });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.get('/streamflex/content/:id', async (req, res, next) => {
  try {
    const source = req.query.source === 'nexoplay' ? 'nexoplay' : 'streamflex';
    const base = source === 'nexoplay' ? getNexoPlayBase() : getStreamFlexBase();

    const { data } = await axios.get(`${base}/content/${req.params.id}`, {
      timeout: 8000,
    });

    const rawItem: RawExternalContentItem = data?.data || data;
    const normalized = normalizeExternalStreamingItem(rawItem, source);

    let tmdbData = null;
    const isTv = normalized.mediaType !== 'MOVIE';
    try {
      if (normalized.tmdbId) {
        tmdbData = await fetchTmdbDetails(normalized.tmdbId, isTv);
      } else if (process.env.TMDB_API_KEY && normalized.title) {
        const searchEndpoint = isTv ? 'search/tv' : 'search/movie';
        const searchRes = await axios.get(`${TMDB_BASE}/${searchEndpoint}`, {
          params: {
            api_key: process.env.TMDB_API_KEY,
            language: 'es-MX',
            query: normalized.originalTitle || normalized.title,
            ...(normalized.releaseYear
              ? isTv
                ? { first_air_date_year: normalized.releaseYear }
                : { year: normalized.releaseYear }
              : {}),
          },
          timeout: 6000,
        });
        const firstHit = searchRes.data?.results?.[0];
        if (firstHit?.id) {
          tmdbData = await fetchTmdbDetails(firstHit.id, isTv);
        }
      }
    } catch {
      tmdbData = null;
    }

    const enriched = {
      ...normalized,
      tmdbId: tmdbData?.tmdbId ?? normalized.tmdbId,
      tagline: tmdbData?.tagline || normalized.tagline,
      synopsis: normalized.synopsis || tmdbData?.synopsis || '',
      posterUrl: normalized.posterUrl || tmdbData?.posterUrl || null,
      backdropUrl: normalized.backdropUrl || tmdbData?.backdropUrl || null,
      rating: normalized.rating ?? tmdbData?.rating ?? null,
      duration: normalized.duration ?? tmdbData?.duration ?? null,
      trailerUrl: normalized.trailerUrl || tmdbData?.trailerUrl || null,
      genres: normalized.genres.length > 0 ? normalized.genres : tmdbData?.genres || [],
      cast: tmdbData?.cast || [],
      seasonsCount: tmdbData?.seasonsCount ?? null,
    };

    res.json({ item: enriched, tmdbMatched: Boolean(tmdbData) });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.get('/tmdb/search', async (req, res, next) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    const type = req.query.type === 'tv' ? 'tv' : req.query.type === 'movie' ? 'movie' : 'multi';
    if (!query) {
      res.status(400).json({ error: 'Ingresá un título para buscar en TMDB.' });
      return;
    }
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: 'TMDB_API_KEY no configurada en el servidor.' });
      return;
    }

    const { data } = await axios.get(`${TMDB_BASE}/search/${type}`, {
      params: { api_key: apiKey, language: 'es-MX', query, include_adult: false },
      timeout: 7000,
    });

    const results = (data?.results || [])
      .filter((r: { media_type?: string }) => !r.media_type || r.media_type !== 'person')
      .slice(0, 15)
      .map((r: Record<string, unknown>) => {
        const isTv = r.media_type === 'tv' || type === 'tv' || Boolean(r.first_air_date);
        const dateStr = (isTv ? r.first_air_date : r.release_date) as string | undefined;
        return {
          source: 'tmdb',
          tmdbId: r.id,
          mediaType: isTv ? 'SERIES' : 'MOVIE',
          title: (isTv ? r.name : r.title) || r.original_name || r.original_title,
          originalTitle: isTv ? r.original_name : r.original_title,
          synopsis: r.overview || '',
          posterUrl: r.poster_path ? `${TMDB_IMG}/w500${r.poster_path}` : null,
          backdropUrl: r.backdrop_path ? `${TMDB_IMG}/w1280${r.backdrop_path}` : null,
          releaseYear: dateStr ? Number(dateStr.slice(0, 4)) : null,
          rating: typeof r.vote_average === 'number' ? Number(r.vote_average.toFixed(1)) : null,
        };
      });

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// ─── NUBATV API (PLAYLISTS, CANALES, CATEGORÍAS, PAÍSES) ──────────────────────

integrationsRouter.get('/nubatv/summary', async (_req, res, next) => {
  try {
    const base = getNubaTvBase();
    const results = await Promise.allSettled([
      axios.get(`${base}/playlists`, { timeout: 8000 }),
      axios.get(`${base}/categories`, { timeout: 8000 }),
      axios.get(`${base}/countries`, { timeout: 8000 }),
      axios.get(`${base}/languages`, { timeout: 8000 }),
    ]);

    const anyFulfilled = results.some((r) => r.status === 'fulfilled');
    if (!anyFulfilled) {
      const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      return next(firstRejected?.reason ?? new Error('NubaTV API no disponible'));
    }

    const [playlistsRes, categoriesRes, countriesRes, languagesRes] = results;
    res.json({
      playlists: playlistsRes.status === 'fulfilled' ? extractList(playlistsRes.value.data) : [],
      categories: categoriesRes.status === 'fulfilled' ? extractList(categoriesRes.value.data) : [],
      countries: countriesRes.status === 'fulfilled' ? extractList(countriesRes.value.data) : [],
      languages: languagesRes.status === 'fulfilled' ? extractList(languagesRes.value.data) : [],
    });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.get('/nubatv/channels', async (req, res, next) => {
  try {
    const base = getNubaTvBase();
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 24, 60);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const playlistId = typeof req.query.playlistId === 'string' ? req.query.playlistId : undefined;
    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;

    const { data } = await axios.get(`${base}/channels`, {
      params: { page, limit, search, categoryId, playlistId, country, language },
      timeout: 8000,
    });

    const channels = extractList(data);
    res.json({
      channels,
      meta: data?.meta || { page, limit, total: channels.length, totalPages: 1 },
    });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (axios.isAxiosError(err)) {
    const upstreamStatus = err.response?.status;
    res.status(502).json({
      error: upstreamStatus
        ? `El servicio externo respondió con estado ${upstreamStatus}.`
        : 'No se pudo conectar con el servicio externo (timeout o servicio no disponible).',
      upstreamStatus: upstreamStatus ?? null,
    });
    return;
  }
  next(err);
});
