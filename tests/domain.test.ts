import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLeagueStandings } from '../src/modules/football/football.routes';
import { pickCryptoWinnerIndex } from '../src/modules/giveaways/giveaways.routes';
import { normalizeExternalStreamingItem } from '../src/modules/integrations/integrations.routes';

test('computeLeagueStandings calcula puntos y desempata por diferencia de goles y goles a favor', () => {
  const teams = [
    { id: 't1', name: 'Nuba FC' },
    { id: 't2', name: 'Stream United' },
    { id: 't3', name: 'Atlético TV' },
  ];

  const matches = [
    { homeTeamId: 't1', awayTeamId: 't2', homeScore: 3, awayScore: 0 }, // t1 +3 (+3 GF)
    { homeTeamId: 't2', awayTeamId: 't3', homeScore: 2, awayScore: 2 }, // t2 1pt, t3 1pt
    { homeTeamId: 't3', awayTeamId: 't1', homeScore: 1, awayScore: 2 }, // t1 +3
  ];

  const table = computeLeagueStandings(teams, matches);
  assert.equal(table[0].teamId, 't1');
  assert.equal(table[0].points, 6);
  assert.equal(table[0].goalDiff, 4);
  assert.equal(table[0].position, 1);

  assert.equal(table[1].teamId, 't3');
  assert.equal(table[1].points, 1);
  assert.equal(table[1].goalDiff, -1);

  assert.equal(table[2].teamId, 't2');
  assert.equal(table[2].points, 1);
  assert.equal(table[2].goalDiff, -3);
});

test('pickCryptoWinnerIndex selecciona índice dentro del rango válido', () => {
  for (let i = 0; i < 20; i++) {
    const idx = pickCryptoWinnerIndex(5);
    assert.ok(idx >= 0 && idx < 5);
  }
  assert.throws(() => pickCryptoWinnerIndex(0), /al menos un participante/);
});

test('normalizeExternalStreamingItem normaliza payload de StreamFlex', () => {
  const normalized = normalizeExternalStreamingItem(
    {
      id: 'sf-1',
      type: 'SERIES',
      releaseYear: 2025,
      rating: 8.7,
      translations: [{ language: 'es', title: 'El Eternauta', description: 'Ciencia ficción argentina.' }],
      thumbnails: [
        { type: 'POSTER', url: 'https://img.example/poster.jpg' },
        { type: 'BACKDROP', url: 'https://img.example/bg.jpg' },
      ],
      genres: [{ genre: { name: 'Sci-Fi' } }],
    },
    'streamflex'
  );

  assert.equal(normalized.title, 'El Eternauta');
  assert.equal(normalized.mediaType, 'SERIES');
  assert.equal(normalized.posterUrl, 'https://img.example/poster.jpg');
  assert.equal(normalized.backdropUrl, 'https://img.example/bg.jpg');
  assert.deepEqual(normalized.genres, ['Sci-Fi']);
});
