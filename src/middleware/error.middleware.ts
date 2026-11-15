import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Datos inválidos.',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen supera el límite máximo permitido de 5 MB.'
        : `Error al subir archivo: ${err.message}`,
    });
    return;
  }

  if (err instanceof Error) {
    const statusCode = (err as { statusCode?: number }).statusCode || 500;
    if (statusCode >= 500) {
      console.error('[API Error]', err);
    }
    res.status(statusCode).json({
      error: err.message || 'Error interno del servidor.',
    });
    return;
  }

  res.status(500).json({ error: 'Error interno inesperado.' });
}
