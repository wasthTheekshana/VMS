import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertStrongPassword } from '../users/user-rules';

export const BCRYPT_COST = 12;
// Compared against when the username is unknown, so timing does not reveal valid accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string) {
    const normalised = username.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { username: normalised } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.isActive || !ok) {
      await this.audit.record({ action: 'login_failed', entity: 'user', after: { username: normalised } });
      throw new UnauthorizedException('Invalid username or password');
    }
    await this.audit.record({ userId: user.id, action: 'login', entity: 'user', entityId: user.id });
    return { token: await this.jwt.signAsync({ sub: user.id }), user };
  }

  /** Self-service: verifies the current password so a hijacked idle session cannot silently take over the account. */
  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(current, user.passwordHash))) throw new UnauthorizedException('Current password is incorrect');
    assertStrongPassword(next);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(next, BCRYPT_COST) } });
    await this.audit.record({ userId, action: 'change_password', entity: 'user', entityId: userId });
  }

  refresh(userId: string) {
    return this.jwt.signAsync({ sub: userId });
  }
}
