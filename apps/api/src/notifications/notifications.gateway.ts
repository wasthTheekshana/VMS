import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Role } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { COOKIE_NAME } from '../common/guards';
import { isSessionCurrent, SessionClaims } from '../auth/session';
import { loadEnv } from '../config/env';

export const rooms = {
  user: (id: string) => `user:${id}`,
  guardRoom: (id: string) => `guardroom:${id}`,
  dept: (id: string) => `dept:${id}`,
  admins: 'admins',
};

/** The rooms a user may be in, derived only from their CURRENT record (never from what they asked for). */
export function roomsFor(u: { id: string; role: Role; guardRoomId: string | null; departmentId: string | null }): string[] {
  const r = [rooms.user(u.id)];
  if (u.role === 'super_admin') r.push(rooms.admins);
  if (u.role === 'guard' && u.guardRoomId) r.push(rooms.guardRoom(u.guardRoomId));
  if (u.role === 'dept_admin' && u.departmentId) r.push(rooms.dept(u.departmentId));
  return r.sort();
}

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
 * The connection is dropped the moment its session is revoked or its rooms would change, and re-checked every minute.
 */
@Injectable()
@WebSocketGateway({
  path: '/ws',
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly log = new Logger('Realtime');
  private readonly maxHours = loadEnv().sessionMaxHours;
  private sweeper?: NodeJS.Timeout;
  /** userId -> latest refreshed cookie expiry (epoch seconds). Entries are dropped once they have passed. */
  private readonly refreshedUntil = new Map<string, number>();

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
      const claims = await this.jwt.verifyAsync<SessionClaims>(token);
      const u = await this.prisma.user.findUnique({ where: { id: claims.sub } });
      if (!u?.isActive || !isSessionCurrent(claims, u, this.maxHours)) throw new Error('session revoked or expired');
      const joins = roomsFor(u);
      socket.data = { userId: u.id, exp: claims.exp, tv: claims.tv, at: claims.at, rooms: joins.join(',') };
      await socket.join(joins);
    } catch (e) {
      // Reason only (no cookie, token or user data), so an operator can tell a missing cookie from an expired session.
      this.log.warn(`Socket refused: ${e instanceof Error ? e.message : 'unknown error'}`);
      socket.disconnect(true); // unauthenticated sockets get nothing
    }
  }

  /** The user's session cookie was just refreshed and is valid until `exp` (epoch seconds): their open sockets stay alive until then. */
  sessionRefreshed(userId: string, exp: number) {
    if (exp > (this.refreshedUntil.get(userId) ?? 0)) this.refreshedUntil.set(userId, exp);
  }

  /** End every live connection of a user at once (logout, password change/reset, deactivation, reassignment). */
  disconnectUser(userId: string) {
    this.server?.in(rooms.user(userId)).disconnectSockets(true);
  }

  /**
   * Safety net behind the immediate disconnects: drop sockets whose session expired or was revoked, whose user was
   * deactivated, or whose room set no longer matches the user's CURRENT role / guard room / department.
   */
  private async sweep() {
    const sockets = await this.server.fetchSockets();
    if (!sockets.length) return;
    const nowSec = Date.now() / 1000;
    for (const [id, exp] of this.refreshedUntil) if (exp < nowSec) this.refreshedUntil.delete(id);
    const ids = [...new Set(sockets.map((s) => s.data.userId as string))];
    const users = new Map(
      (await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, isActive: true, tokenVersion: true, role: true, guardRoomId: true, departmentId: true },
      })).map((u) => [u.id, u]),
    );
    for (const s of sockets) {
      const u = users.get(s.data.userId);
      // Idle expiry follows the session cookie: the socket's own token only covers the window that was current when it
      // opened, so the latest refresh for this user extends it. No refresh for the whole idle window ends the socket.
      const idleUntil = Math.max(s.data.exp, this.refreshedUntil.get(s.data.userId) ?? 0);
      const stale =
        !u || !u.isActive || idleUntil < nowSec ||
        !isSessionCurrent({ tv: s.data.tv, at: s.data.at }, u, this.maxHours, nowSec) ||
        roomsFor(u).join(',') !== s.data.rooms;
      if (stale) s.disconnect(true);
    }
  }

  emit(targets: string[], event: string, payload: unknown) {
    if (!targets.length || !this.server) return;
    this.server.to(targets).emit(event, payload);
  }
}
