import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { isSessionCurrent, SessionClaims } from '../auth/session';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC, ROLES } from './decorators';

export const COOKIE_NAME = 'vms_session';

/** Global: every route requires a valid session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly maxHours = loadEnv().sessionMaxHours;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token: string | undefined = req.cookies?.[COOKIE_NAME];
    if (!token) throw new UnauthorizedException();
    let claims: SessionClaims;
    try {
      claims = await this.jwt.verifyAsync<SessionClaims>(token);
    } catch {
      throw new UnauthorizedException();
    }
    // Re-read from DB so deactivation / role changes / logout / password changes take effect immediately.
    const u = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!u || !u.isActive || !isSessionCurrent(claims, u, this.maxHours)) throw new UnauthorizedException();
    req.user = { id: u.id, name: u.name, role: u.role, departmentId: u.departmentId, guardRoomId: u.guardRoomId };
    return true;
  }
}

/** Global, runs after AuthGuard: enforces @Roles(...) server-side (NFR-5). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
