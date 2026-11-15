import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app';

function startTestServer() {
  const app = createApp();
  const server = http.createServer(app);
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Failed to bind test server');
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('API cerrada: health OK, registro bloqueado (403), contenido protegido sin sesión (401)', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { status: string; service: string };
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.service, 'nuba-social-api');

    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'intruso', password: 'Password123!' }),
    });
    assert.equal(regRes.status, 403);

    const protectedPaths = [
      '/api/posts',
      '/api/posts/radar',
      '/api/football/matches',
      '/api/football/leagues',
      '/api/polls',
      '/api/giveaways',
      '/api/chats/topics/FOOTBALL',
      '/api/chats/direct/threads',
      '/api/notifications',
      '/api/admin/settings',
      '/api/settings',
    ];

    for (const p of protectedPaths) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.equal(res.status, 401, `Se esperaba 401 sin token en ${p}, devolvió ${res.status}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
