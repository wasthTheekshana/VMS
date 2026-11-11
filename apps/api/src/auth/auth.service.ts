import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { assertStrongPassword } from '../users/user-rules';
import { isSessionCurrent, SessionClaims } from './session';

export const BCRYPT_COST = 12;
// Compared against when the username is unknown, so timing does not reveal valid accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

@Injectable()
export class AuthService {
  private readonly maxHours = loadEnv().sessionMaxHours;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly gateway: NotificationsGateway,
  ) {}

  /** `at` is the moment the user really signed in; refreshes carry it forward unchanged. */
  private issue(userId: string, tokenVersion: number, at = Math.floor(Date.now() / 1000)) {
    return this.jwt.signAsync({ sub: userId, tv: tokenVersion, at });
  }

  async login(username: string, password: string) {
    const normalised = username.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { username: normalised } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.isActive || !ok) {
      await this.audit.record({ action: 'login_failed', entity: 'user', after: { username: normalised } });
      throw new UnauthorizedException('Invalid username or password');
    }
    await this.audit.record({ userId: user.id, action: 'login', entity: 'user', entityId: user.id });
    return { token: await this.issue(user.id, user.tokenVersion), user };
  }

  /** A session cookie value checked against the CURRENT user record, or null if forged, expired, revoked or inactive. */
  private async verify(token?: string) {
    if (!token) return null;
    try {
      const claims = await this.jwt.verifyAsync<SessionClaims>(token);
      const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
      if (!user?.isActive || !isSessionCurrent(claims, user, this.maxHours)) return null;
      return { claims, user };
    } catch {
      return null;
    }
  }

  /** Slides the idle window only. The original sign-in time is kept, so the absolute limit cannot be extended. */
  async refresh(token?: string) {
    const s = await this.verify(token);
    if (!s) throw new UnauthorizedException();
    const fresh = await this.issue(s.user.id, s.user.tokenVersion, s.claims.at);
    // An open page refreshes its cookie every few minutes; tell the live channel so its sockets share that idle window.
    const exp = (this.jwt.decode(fresh) as { exp?: number } | null)?.exp;
    if (exp) this.gateway.sessionRefreshed(s.user.id, exp);
    return fresh;
  }

  /** Logout ends the session for real: the token version is bumped, so a copied cookie stops working too. */
  async logout(token?: string) {
    const s = await this.verify(token);
    if (!s) return;
    await this.prisma.user.update({ where: { id: s.user.id }, data: { tokenVersion: { increment: 1 } } });
    this.gateway.disconnectUser(s.user.id);
    await this.audit.record({ userId: s.user.id, action: 'logout', entity: 'user', entityId: s.user.id });
  }

  /**
   * Self-service: verifies the current password, then ends every other session of this user. The browser that made
   * the change gets a fresh token, so it stays signed in.
   */
  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new UnauthorizedException('Current password is incorrect');
    assertStrongPassword(next);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(next, BCRYPT_COST), tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    this.gateway.disconnectUser(userId);
    await this.audit.record({ userId, action: 'change_password', entity: 'user', entityId: userId });
    return this.issue(userId, updated.tokenVersion);
  }
}
