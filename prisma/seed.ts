import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Nuba Club database...');

  // 1. System settings singleton
  await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      appName: 'Nuba Club',
      announcementBanner: '¡Bienvenidos a Nuba Club! Todos los estrenos, partidos, TV y sorteos en un solo lugar.',
      chatsEnabled: true,
      commentsEnabled: true,
      likesEnabled: true,
      giveawaysEnabled: true,
      pollsEnabled: true,
      historyEnabled: true,
      directChatEnabled: true,
      chatImagesEnabled: true,
      ratingsEnabled: true,
      maxCommentLength: 400,
      commentCooldownSec: 5,
      chatImageCooldownSec: 45,
      blockLinksInComments: true,
    },
  });

  // 2. Topic chat room configs
  for (const topic of ['FOOTBALL', 'STREAMING', 'NEWS', 'TV_CHANNELS'] as const) {
    await prisma.topicRoomConfig.upsert({
      where: { topic },
      update: {},
      create: {
        topic,
        isLocked: false,
        notice: `Sala oficial de ${topic === 'FOOTBALL' ? 'Fútbol' : topic === 'STREAMING' ? 'Streaming' : topic === 'NEWS' ? 'Noticias' : 'TV Canales'}. ¡Respeta las reglas del club!`,
      },
    });
  }

  // 3. Default restricted words
  const bannedWords = ['spam', 'estafa', 'scam', 'phishing'];
  for (const word of bannedWords) {
    await prisma.restrictedWord.upsert({
      where: { word },
      update: {},
      create: { word },
    });
  }

  // 4. Users (solo cuentas creadas por Admin)
  const adminHash = await bcrypt.hash('admin123456', 12);
  const userHash = await bcrypt.hash('nuba123456', 12);

  const superAdmin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@nubaclub.com',
      passwordHash: adminHash,
      displayName: 'Admin Nuba Club',
      bio: 'Administrador oficial de Nuba Club ⚡',
      role: 'SUPERADMIN',
      preferredTheme: 'classic',
      notificationPreference: { create: {} },
    },
  });

  const demoUser1 = await prisma.user.upsert({
    where: { username: 'usuario1' },
    update: {},
    create: {
      username: 'usuario1',
      email: 'usuario1@nubaclub.com',
      passwordHash: userHash,
      displayName: 'Alex Nuba',
      bio: 'Fanático del fútbol y estrenos 🎬⚽',
      role: 'USER',
      preferredTheme: 'classic',
      notificationPreference: { create: {} },
    },
  });

  const demoUser2 = await prisma.user.upsert({
    where: { username: 'usuario2' },
    update: {},
    create: {
      username: 'usuario2',
      email: 'usuario2@nubaclub.com',
      passwordHash: userHash,
      displayName: 'Sofi VIP',
      bio: 'Siempre atenta a los sorteos 🎁',
      role: 'USER',
      preferredTheme: 'cute',
      notificationPreference: { create: {} },
    },
  });

  // 5. Liga, Equipos, Partidos y Tabla de Posiciones
  const existingLeague = await prisma.league.findFirst({ where: { name: 'Liga Nuba Premier' } });
  if (!existingLeague) {
    const league = await prisma.league.create({
      data: {
        name: 'Liga Nuba Premier',
        shortName: 'LNP',
        country: 'Argentina',
        season: '2026',
        description: 'Torneo principal de fútbol seguido en Nuba Club',
      },
    });

    const teamA = await prisma.team.create({
      data: {
        name: 'Atlético Nuba',
        shortName: 'ANB',
        stadium: 'Estadio Monumental Nuba',
        city: 'Buenos Aires',
        country: 'Argentina',
        colorPrimary: '#F9E4A0',
        colorSecondary: '#2D2D2D',
        leagueId: league.id,
      },
    });

    const teamB = await prisma.team.create({
      data: {
        name: 'Real Stream FC',
        shortName: 'RSF',
        stadium: 'Arena Flex',
        city: 'Córdoba',
        country: 'Argentina',
        colorPrimary: '#F4A7B9',
        colorSecondary: '#1A1A2E',
        leagueId: league.id,
      },
    });

    const teamC = await prisma.team.create({
      data: {
        name: 'Deportivo Cyber',
        shortName: 'DCY',
        stadium: 'Estadio Neón',
        city: 'Rosario',
        country: 'Argentina',
        colorPrimary: '#00F0FF',
        colorSecondary: '#111111',
        leagueId: league.id,
      },
    });

    await prisma.standing.createMany({
      data: [
        { leagueId: league.id, teamId: teamA.id, played: 5, won: 4, drawn: 1, lost: 0, goalsFor: 12, goalsAgainst: 4, goalDiff: 8, points: 13, position: 1 },
        { leagueId: league.id, teamId: teamB.id, played: 5, won: 3, drawn: 1, lost: 1, goalsFor: 9, goalsAgainst: 5, goalDiff: 4, points: 10, position: 2 },
        { leagueId: league.id, teamId: teamC.id, played: 5, won: 2, drawn: 0, lost: 3, goalsFor: 6, goalsAgainst: 8, goalDiff: -2, points: 6, position: 3 },
      ],
    });

    const match = await prisma.match.create({
      data: {
        leagueId: league.id,
        homeTeamId: teamA.id,
        awayTeamId: teamB.id,
        matchDate: new Date(Date.now() + 1000 * 60 * 60 * 6),
        matchday: 'Fecha 6 — Clásico Nuba',
        stadium: 'Estadio Monumental Nuba',
        location: 'Buenos Aires, Argentina',
        broadcastInfo: 'NubaTV Canal Deportes 1 HD',
        status: 'UPCOMING',
        featureMode: 'AUTO',
        notes: '¡Duelo por la punta del torneo!',
      },
    });

    await prisma.post.create({
      data: {
        topic: 'FOOTBALL',
        subType: 'MATCH_FEATURE',
        title: 'Atlético Nuba vs Real Stream FC — Fecha 6',
        content: '¡Partidazo hoy por la cima de la Liga Nuba Premier! No te pierdas la transmisión en NubaTV Deportes 1.',
        tags: ['futbol', 'fecha6', 'envivo'],
        isPinned: true,
        matchId: match.id,
        authorId: superAdmin.id,
      },
    });

    await prisma.post.create({
      data: {
        topic: 'FOOTBALL',
        subType: 'FOOTBALL_POST',
        title: 'Resumen de la fecha y tabla actualizada',
        content: 'Ya quedó actualizada la tabla de posiciones después de la Fecha 5. ¿Quién se lleva el torneo este año? Comenten abajo 👇⚽',
        tags: ['resumen', 'tabla'],
        authorId: superAdmin.id,
      },
    });
  }

  // 6. Posts iniciales en Streaming, Noticias y TV Canales
  const postCount = await prisma.post.count();
  if (postCount <= 2) {
    await prisma.post.create({
      data: {
        topic: 'STREAMING',
        subType: 'MOVIE',
        title: 'Estrenos de la semana en Flex & NexoPlay',
        content: 'Ya cargamos nuevas películas y series en calidad Full HD y 4K. ¡Calificá qué te pareció con estrellas y dejá tu comentario!',
        tags: ['estrenos', '4k', 'peliculas'],
        isPinned: true,
        authorId: superAdmin.id,
        metadata: {
          contentType: 'MOVIE',
          releaseYear: 2026,
          duration: 124,
          tmdbRating: 8.4,
          platformName: 'Flex-Streaming / NexoPlay',
          genres: ['Acción', 'Ciencia Ficción'],
          synopsis: 'Selección destacada de la semana ya disponible en nuestras apps de streaming.',
        },
      },
    });

    await prisma.post.create({
      data: {
        topic: 'NEWS',
        subType: 'PREMIUM',
        title: 'Aviso: Nuevas cuentas Demo y renovaciones Premium',
        content: 'Si necesitas renovar tu acceso o pedir una cuenta demo para probar nuestras plataformas, escríbenos por el Chat Directo con Admin.',
        tags: ['premium', 'demo', 'aviso'],
        authorId: superAdmin.id,
        metadata: { category: 'PREMIUM' },
      },
    });

    await prisma.post.create({
      data: {
        topic: 'TV_CHANNELS',
        subType: 'PLAYLIST_ADDED',
        title: 'Nueva lista de canales en vivo agregada a NubaTV',
        content: 'Sumamos canales de Deportes, Noticias, Entretenimiento e Infantil listos para ver desde NubaTV Mobile y TV.',
        tags: ['nubatv', 'm3u', 'deportes'],
        authorId: superAdmin.id,
        metadata: {
          playlistName: 'Deportes & Latino HD',
          totalChannels: 143,
          categories: ['Sports', 'News', 'Entertainment', 'Kids'],
          countries: ['Argentina', 'España', 'México'],
          languages: ['Español'],
        },
      },
    });
  }

  // 7. Encuesta y Sorteo de ejemplo
  const pollCount = await prisma.poll.count();
  if (pollCount === 0) {
    await prisma.poll.create({
      data: {
        question: '¿Qué maratón de fin de semana agregamos primero?',
        description: 'Votá la saga o torneo que querés ver destacado esta semana.',
        topic: 'STREAMING',
        allowMultiple: false,
        options: {
          create: [
            { label: 'Estrenos de Acción 2026', sortOrder: 0 },
            { label: 'Animes en Emisión', sortOrder: 1 },
            { label: 'Especial Champions & Fútbol', sortOrder: 2 },
          ],
        },
      },
    });
  }

  const giveawayCount = await prisma.giveaway.count();
  if (giveawayCount === 0) {
    await prisma.giveaway.create({
      data: {
        title: 'Sorteo Semanal Nuba Club #1',
        description: 'Anotate gratis y participá del sorteo en vivo para ganar accesos completos.',
        prizeDescription: '1 Cuenta Premium Streaming + NubaTV 30 días',
        scheduledAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
        status: 'OPEN',
        entries: {
          create: [{ userId: demoUser1.id }, { userId: demoUser2.id }],
        },
      },
    });
  }

  console.log('✅ Seed completado.');
  console.log('   Admin: admin / admin123456');
  console.log('   User1: usuario1 / nuba123456');
  console.log('   User2: usuario2 / nuba123456');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
