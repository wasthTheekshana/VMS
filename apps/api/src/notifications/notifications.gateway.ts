import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { COOKIE_NAME } from '../common/guards';

export const rooms = {
  user: (id: string) => `user:${id}`,
  guardRoom: (id: string) => `guardroom:${id}`,
  dept: (id: string) => `dept:${id}`,
  admins: 'admins',
};

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * Real-time channel (NFR-2). A socket is authenticated from the same HttpOnly session cookie and may only join
 * rooms derived server-side from its user record, so a guard can never receive another guard room's events (FR-17).
 */
@Injectable()
@WebSocketGateway({
  path: '/ws',
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly log = new Logger('Realtime');
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), 60_000);
    this.sweeper.unref();
  }
  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async handleConnection(socket: Socket) {
    try {
      const token = readCookie(socket.handshake.headers.cookie, COOKIE_NAME);
      if (!token) throw new Error('no session');
      const claims = await this.jwt.verifyAsync<{ sub: string; exp: number }>(token);
      const u = await this.prisma.user.findUnique({ where: { id: claims.sub } });
      if (!u?.isActive) throw new Error('inactive');
      socket.data.userId = u.id;
      socket.data.exp = claims.exp;
      const joins = [rooms.user(u.id)];
      if (u.role === 'super_admin') joins.push(rooms.admins);
      if (u.role === 'guard' && u.guardRoomId) joins.push(rooms.guardRoom(u.guardRoomId));
      if (u.role === 'dept_admin' && u.departmentId) joins.push(rooms.dept(u.departmentId));
      await socket.join(joins);
    } catch {
      socket.disconnect(true); // unauthenticated sockets get nothing
    }
  }

  /** Drop sockets whose session expired or whose user was deactivated. */
  private async sweep() {
    const sockets = await this.server.fetchSockets();
    const now = Date.now() / 1000;
    const ids = [...new Set(sockets.map((s) => s.data.userId as string))];
    const active = new Set(
      (await this.prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } })).map((u) => u.id),
    );
    for (const s of sockets) if (s.data.exp < now || !active.has(s.data.userId)) s.disconnect(true);
  }

  emit(targets: string[], event: string, payload: unknown) {
    if (!targets.length || !this.server) return;
    this.server.to(targets).emit(event, payload);
  }
}
