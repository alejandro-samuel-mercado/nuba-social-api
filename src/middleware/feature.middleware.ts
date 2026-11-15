import { NextFunction, Request, Response } from 'express';
import { getSystemSettings, isStaffRole } from '../lib/settings';

export type FeatureFlagKey =
  | 'chatsEnabled'
  | 'commentsEnabled'
  | 'likesEnabled'
  | 'giveawaysEnabled'
  | 'pollsEnabled'
  | 'historyEnabled'
  | 'directChatEnabled'
  | 'ratingsEnabled';

const FEATURE_LABELS: Record<FeatureFlagKey, string> = {
  chatsEnabled: 'Los chats de temas están desactivados por el administrador.',
  commentsEnabled: 'Los comentarios están desactivados por el administrador.',
  likesEnabled: 'Las reacciones y likes están desactivados por el administrador.',
  giveawaysEnabled: 'Los sorteos están desactivados por el administrador.',
  pollsEnabled: 'Las encuestas están desactivadas por el administrador.',
  historyEnabled: 'El historial de sorteos está desactivado por el administrador.',
  directChatEnabled: 'El contacto directo con administración está desactivado.',
  ratingsEnabled: 'Las calificaciones están desactivadas por el administrador.',
};

/**
 * Bloquea el acceso a una funcionalidad cuando está desactivada desde el panel Admin.
 * Los administradores pueden seguir gestionando desde su panel cuando bypassForStaff = true.
 */
export function requireFeatureEnabled(flag: FeatureFlagKey, bypassForStaff = false) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (bypassForStaff && req.user && isStaffRole(req.user.role)) {
        next();
        return;
      }
      const settings = await getSystemSettings();
      if (!settings[flag]) {
        res.status(403).json({
          error: FEATURE_LABELS[flag],
          featureDisabled: flag,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
