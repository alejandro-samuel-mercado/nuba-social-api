import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { getSystemSettings } from '../../lib/settings';
import { requireAuth } from '../../middleware/auth.middleware';

export const authRouter = Router();

const VALID_THEMES = ['classic', 'cute', 'minimal', 'concert', 'oscuro'] as const;

const loginSchema = z.object({
  identifier: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  password: z.string().min(1, 'Ingresá tu contraseña'),
});

const profileUpdateSchema = z.object({
  displayName: z.string().min(2).max(60).optional(),
  bio: z.string().max(250).nullable().optional(),
  avatarUrl: z.string().max(500).nullable().optional(),
  preferredTheme: z.enum(VALID_THEMES).optional(),
  customColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color hexadecimal inválido')
    .nullable()
    .optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres'),
});

function signAccessToken(user: { id: string; role: string }): string {
  const secret = process.env.JWT_SECRET || 'nuba-club-dev-jwt-secret-change-in-production-2026';
  return jwt.sign({ userId: user.id, role: user.role }, secret, { expiresIn: '7d' });
}

// Registro público bloqueado estrictamente
authRouter.post('/register', (_req, res) => {
  res.status(403).json({
    error: 'El registro público está deshabilitado. Solo un administrador puede crear cuentas en Nuba Club.',
  });
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const identifier = (parsed.identifier || parsed.username || parsed.email || '').trim();
    if (!identifier) {
      res.status(400).json({ error: 'Ingresá tu usuario o email.' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: { notificationPreference: true },
    });

    if (!user) {
      res.status(401).json({ error: 'Credenciales incorrectas.' });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({ error: 'Tu cuenta fue deshabilitada por administración.' });
      return;
    }

    const validPassword = await bcrypt.compare(parsed.password, user.passwordHash);
    if (!validPassword) {
      res.status(401).json({ error: 'Credenciales incorrectas.' });
      return;
    }

    const accessToken = signAccessToken(user);
    const refreshTokenValue = uuidv4() + '-' + uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshTokenValue,
        expiresAt,
      },
    });

    const settings = await getSystemSettings();
    const prefs =
      user.notificationPreference ??
      (await prisma.notificationPreference.create({ data: { userId: user.id } }));

    res.cookie('nuba_token', accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      token: accessToken,
      refreshToken: refreshTokenValue,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        role: user.role,
        isMuted: user.isMuted,
        preferredTheme: user.preferredTheme,
        customColor: user.customColor,
        lastVisitAt: user.lastVisitAt,
      },
      preferences: prefs,
      settings,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token requerido.' });
      return;
    }

    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored || stored.expiresAt < new Date() || !stored.user.isActive) {
      res.status(401).json({ error: 'Sesión expirada. Volvé a iniciar sesión.' });
      return;
    }

    const accessToken = signAccessToken(stored.user);
    res.cookie('nuba_token', accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      token: accessToken,
      user: {
        id: stored.user.id,
        username: stored.user.username,
        email: stored.user.email,
        displayName: stored.user.displayName,
        bio: stored.user.bio,
        avatarUrl: stored.user.avatarUrl,
        role: stored.user.role,
        isMuted: stored.user.isMuted,
        preferredTheme: stored.user.preferredTheme,
        customColor: stored.user.customColor,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.clearCookie('nuba_token');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        isMuted: true,
        preferredTheme: true,
        customColor: true,
        lastVisitAt: true,
        createdAt: true,
        notificationPreference: true,
      },
    });

    const settings = await getSystemSettings();
    const unreadNotifications = await prisma.notification.count({
      where: { userId, isRead: false },
    });

    const isStaff = ['SUPERADMIN', 'ADMIN', 'MODERATOR'].includes(user.role);
    const unreadDirectMessages = isStaff
      ? (
          await prisma.directThread.aggregate({
            _sum: { unreadForAdmin: true },
          })
        )._sum.unreadForAdmin || 0
      : (
          await prisma.directThread.aggregate({
            where: { userId },
            _sum: { unreadForUser: true },
          })
        )._sum.unreadForUser || 0;

    res.json({
      user,
      preferences: user.notificationPreference,
      settings,
      unreadNotifications,
      unreadDirectMessages,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const data = profileUpdateSchema.parse(req.body);
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isMuted: true,
        preferredTheme: true,
        customColor: true,
      },
    });
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
      return;
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    res.json({ ok: true, message: 'Contraseña actualizada correctamente.' });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/visit', requireAuth, async (req, res, next) => {
  try {
    const now = new Date();
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { lastVisitAt: now },
    });
    res.json({ ok: true, lastVisitAt: now });
  } catch (err) {
    next(err);
  }
});
