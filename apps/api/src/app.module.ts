import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Public } from './common/decorators';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.controller';
import { AuthGuard, RolesGuard } from './common/guards';
import { DepartmentsModule } from './departments/departments.module';
import { GuardRoomsModule } from './guard-rooms/guard-rooms.module';
import { PassCategoriesModule } from './pass-categories/pass-categories.module';
import { UsersModule } from './users/users.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RecordsModule } from './records/records.module';
import { BlacklistModule } from './blacklist/blacklist.module';
import { RetentionModule } from './common/retention.service';
import { VisitsModule } from './visits/visits.module';

/** Container health check (DOK deployment rule: every app exposes /health). Reports status only, never details. */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public() @SkipThrottle() @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}

@Module({
  controllers: [HealthController],
  imports: [
    // Rate limiting is only ever bypassed under the test runner (jest sets NODE_ENV=test).
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }], skipIf: () => process.env.NODE_ENV === 'test' }),
    PrismaModule,
    AuditModule,
    AuthModule,
    DepartmentsModule,
    GuardRoomsModule,
    PassCategoriesModule,
    UsersModule,
    NotificationsModule,
    RecordsModule,
    BlacklistModule,
    RetentionModule,
    VisitsModule,
  ],
  providers: [
    // Order matters: throttle -> authenticate -> authorise. Deny by default.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
