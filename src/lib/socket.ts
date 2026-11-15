import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { prisma } from './prisma';

export interface SocketUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

let ioInstance: SocketIOServer | null = null;

function parseCorsOrigins(): string[] | boolean {
  const raw = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : true;
}

function extractTokenFromSocket(socket: Socket): string | null {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.replace(/^Bearer\s+/i, '').trim();
  }
  const headerAuth = socket.handshake.headers.authorization;
  if (typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')) {
    return headerAuth.slice(7).trim();
  }
  const cookieHeader = socket.handshake.headers.cookie;
  if (typeof cookieHeader === 'string') {
    const match = cookieHeader.match(/(?:^|;\s*)nuba_token=([^;]+)/);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

export function initSocket(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: parseCorsOrigins(),
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket, next) => {
    try {
      const token = extractTokenFromSocket(socket);
      if (!token) {
        return next(new Error('UNAUTHORIZED'));
      }
      const secret = process.env.JWT_SECRET || 'nuba-club-dev-jwt-secret-change-in-production-2026';
      const decoded = jwt.verify(token, secret) as { userId?: string };
      if (!decoded?.userId) {
        return next(new Error('UNAUTHORIZED'));
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, displayName: true, role: true, isActive: true },
      });

      if (!user || !user.isActive) {
        return next(new Error('ACCOUNT_DISABLED'));
      }

      socket.data.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      } satisfies SocketUser;

      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as SocketUser | undefined;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.join(`user:${user.id}`);
    socket.join('giveaways');
    socket.join('global');

    if (user.role === 'SUPERADMIN' || user.role === 'ADMIN' || user.role === 'MODERATOR') {
      socket.join('admins');
    }

    socket.on('join_topic', (topic: string) => {
      if (['FOOTBALL', 'STREAMING', 'NEWS', 'TV_CHANNELS'].includes(topic)) {
        socket.join(`topic:${topic}`);
      }
    });

    socket.on('leave_topic', (topic: string) => {
      if (['FOOTBALL', 'STREAMING', 'NEWS', 'TV_CHANNELS'].includes(topic)) {
        socket.leave(`topic:${topic}`);
      }
    });

    socket.on('join_thread', async (threadId: string) => {
      if (!threadId || typeof threadId !== 'string') return;
      if (user.role === 'SUPERADMIN' || user.role === 'ADMIN' || user.role === 'MODERATOR') {
        socket.join(`thread:${threadId}`);
        return;
      }
      const thread = await prisma.directThread.findUnique({
        where: { id: threadId },
        select: { userId: true },
      });
      if (thread?.userId === user.id) {
        socket.join(`thread:${threadId}`);
      }
    });

    socket.on('leave_thread', (threadId: string) => {
      if (typeof threadId === 'string') {
        socket.leave(`thread:${threadId}`);
      }
    });
  });

  ioInstance = io;
  return io;
}

export function getIO(): SocketIOServer | null {
  return ioInstance;
}

export function emitToAll(event: string, payload: unknown): void {
  ioInstance?.to('global').emit(event, payload);
}

export function emitToTopic(topic: string, event: string, payload: unknown): void {
  ioInstance?.to(`topic:${topic}`).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  ioInstance?.to(`user:${userId}`).emit(event, payload);
}

export function emitToAdmins(event: string, payload: unknown): void {
  ioInstance?.to('admins').emit(event, payload);
}

export function emitToThread(threadId: string, event: string, payload: unknown): void {
  ioInstance?.to(`thread:${threadId}`).emit(event, payload);
}
