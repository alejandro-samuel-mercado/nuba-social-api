import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isAdminRole, isStaffRole } from '../lib/settings';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: UserRole;
  avatarUrl: string | null;
  isMuted: boolean;
  preferredTheme: string;
  customColor: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function extractBearerOrCookieToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieToken = req.cookies?.nuba_token;
  if (typeof cookieToken === 'string' && cookieToken.trim()) {
    return cookieToken.trim();
  }
  return null;
}

/**
 * Guardia estricto de acceso cerrado: ningún contenido se expone sin cuenta activa creada por Admin.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerOrCookieToken(req);
    if (!token) {
      res.status(401).json({ error: 'Acceso privado. Iniciá sesión con tu cuenta de Nuba Club.' });
      return;
    }

    const secret = process.env.JWT_SECRET || 'nuba-club-dev-jwt-secret-change-in-production-2026';
    const decoded = jwt.verify(token, secret) as { userId?: string };

    if (!decoded?.userId) {
      res.status(401).json({ error: 'Sesión inválida.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        role: true,
        avatarUrl: true,
        isActive: true,
        isMuted: true,
        preferredTheme: true,
        customColor: true,
      },
    });

    if (!user) {
      res.status(401).json({ error: 'Usuario no encontrado.' });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({ error: 'Tu cuenta está suspendida o deshabilitada por administración.' });
      return;
    }

    req.user = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatarUrl,
      isMuted: user.isMuted,
      preferredTheme: user.preferredTheme,
      customColor: user.customColor,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Tu sesión expiró o es inválida.' });
  }
}

export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isStaffRole(req.user.role)) {
    res.status(403).json({ error: 'Requiere permisos de administración o moderación.' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !isAdminRole(req.user.role)) {
    res.status(403).json({ error: 'Requiere rol de Administrador.' });
    return;
  }
  next();
}

export function requireNotMuted(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.isMuted) {
    res.status(403).json({ error: 'Tu cuenta se encuentra silenciada temporalmente para participar.' });
    return;
  }
  next();
}
