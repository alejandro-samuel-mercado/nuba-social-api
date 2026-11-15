const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+\.(com|net|org|io|tv|me|gg|xyz|co|online|live)(\/[^\s]*)?)/i;

const DEFAULT_RESTRICTED_WORDS = ['spam', 'estafa', 'phishing', 'scam'];

export interface ModerationCheckOptions {
  maxLength?: number;
  blockLinks?: boolean;
  restrictedWords?: string[];
}

export interface ModerationCheckResult {
  ok: boolean;
  reason?: string;
  sanitized: string;
}

/**
 * Valida texto de comentarios o mensajes contra longitud máxima, enlaces y palabras restringidas.
 */
export function checkTextModeration(
  rawText: string,
  options: ModerationCheckOptions = {}
): ModerationCheckResult {
  const sanitized = rawText.trim();
  if (!sanitized) {
    return { ok: false, reason: 'El texto no puede estar vacío.', sanitized };
  }

  const maxLength = options.maxLength ?? 400;
  if (sanitized.length > maxLength) {
    return {
      ok: false,
      reason: `Supera el máximo permitido de ${maxLength} caracteres.`,
      sanitized,
    };
  }

  if (options.blockLinks && URL_REGEX.test(sanitized)) {
    return {
      ok: false,
      reason: 'No se permiten enlaces ni URLs externas en este espacio.',
      sanitized,
    };
  }

  const normalizedLower = sanitized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const wordList = (options.restrictedWords && options.restrictedWords.length > 0
    ? options.restrictedWords
    : DEFAULT_RESTRICTED_WORDS
  )
    .map((w) =>
      w
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
    )
    .filter(Boolean);

  for (const word of wordList) {
    if (normalizedLower.includes(word)) {
      return {
        ok: false,
        reason: 'Tu mensaje contiene una palabra restringida por la administración.',
        sanitized,
      };
    }
  }

  return { ok: true, sanitized };
}

/**
 * Calcula si el usuario debe esperar antes de publicar otro comentario o imagen.
 */
export function checkCooldownRemaining(
  lastActionDate: Date | null | undefined,
  cooldownSeconds: number
): number {
  if (!lastActionDate || cooldownSeconds <= 0) return 0;
  const elapsedSec = (Date.now() - lastActionDate.getTime()) / 1000;
  if (elapsedSec >= cooldownSeconds) return 0;
  return Math.ceil(cooldownSeconds - elapsedSec);
}
