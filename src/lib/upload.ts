import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function getUploadRoot(): string {
  const configured = process.env.UPLOAD_DIR || 'uploads';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

export function ensureUploadDirs(): void {
  const root = getUploadRoot();
  const subdirs = ['posts', 'teams', 'chat', 'avatars', 'giveaways', 'general'];
  for (const dir of subdirs) {
    const fullPath = path.join(root, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    ensureUploadDirs();
    const rawFolder = typeof req.query.folder === 'string' ? req.query.folder : 'general';
    const safeFolder = ['posts', 'teams', 'chat', 'avatars', 'giveaways', 'general'].includes(
      rawFolder
    )
      ? rawFolder
      : 'general';
    cb(null, path.join(getUploadRoot(), safeFolder));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
    cb(null, `${uuidv4()}${safeExt}`);
  },
});

export const imageUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max para imágenes en avisos, chat y escudos
    files: 4,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype.toLowerCase())) {
      cb(new Error('Solo se permiten imágenes PNG, JPG, WEBP o GIF.'));
      return;
    }
    cb(null, true);
  },
});
