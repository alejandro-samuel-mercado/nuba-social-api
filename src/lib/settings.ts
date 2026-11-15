import { SystemSettings, UserRole } from '@prisma/client';
import { prisma } from './prisma';

export const ADMIN_ROLES: UserRole[] = ['SUPERADMIN', 'ADMIN', 'MODERATOR'];
export const STRICT_ADMIN_ROLES: UserRole[] = ['SUPERADMIN', 'ADMIN'];

export function isStaffRole(role?: UserRole | string | null): boolean {
  if (!role) return false;
  return ADMIN_ROLES.includes(role as UserRole);
}

export function isAdminRole(role?: UserRole | string | null): boolean {
  if (!role) return false;
  return STRICT_ADMIN_ROLES.includes(role as UserRole);
}

export async function getSystemSettings(): Promise<SystemSettings> {
  return prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      appName: 'Nuba Club',
      announcementBanner: '¡Bienvenidos a Nuba Club! Enterate antes que nadie de estrenos, partidos y sorteos.',
    },
  });
}

export async function getRestrictedWordsList(): Promise<string[]> {
  const rows = await prisma.restrictedWord.findMany({
    select: { word: true },
    orderBy: { word: 'asc' },
  });
  return rows.map((r) => r.word);
}
