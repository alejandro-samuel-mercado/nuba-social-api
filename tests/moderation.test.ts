import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCooldownRemaining, checkTextModeration } from '../src/lib/moderation';

test('checkTextModeration acepta mensajes limpios y recorta espacios', () => {
  const res = checkTextModeration('   ¡Qué partidazo hoy a las 21!   ', {
    maxLength: 200,
    blockLinks: true,
    restrictedWords: ['spam', 'casino'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.sanitized, '¡Qué partidazo hoy a las 21!');
});

test('checkTextModeration bloquea enlaces y URLs cuando blockLinks=true', () => {
  const res = checkTextModeration('Miren esto en https://sitio-externo.com/gratis', {
    maxLength: 400,
    blockLinks: true,
    restrictedWords: [],
  });
  assert.equal(res.ok, false);
  assert.match(res.reason || '', /enlaces/i);
});

test('checkTextModeration detecta palabras prohibidas ignorando acentos y mayúsculas', () => {
  const res = checkTextModeration('Esto parece ESTÁFÁ segura', {
    maxLength: 400,
    blockLinks: false,
    restrictedWords: ['estafa'],
  });
  assert.equal(res.ok, false);
  assert.match(res.reason || '', /restringida/i);
});

test('checkTextModeration valida longitud máxima', () => {
  const res = checkTextModeration('a'.repeat(51), { maxLength: 50 });
  assert.equal(res.ok, false);
  assert.match(res.reason || '', /50/);
});

test('checkCooldownRemaining calcula segundos restantes correctamente', () => {
  const fiveSecondsAgo = new Date(Date.now() - 5000);
  const wait = checkCooldownRemaining(fiveSecondsAgo, 20);
  assert.ok(wait >= 14 && wait <= 16);

  const minuteAgo = new Date(Date.now() - 60000);
  assert.equal(checkCooldownRemaining(minuteAgo, 20), 0);
});
