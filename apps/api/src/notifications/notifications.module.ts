import {
  Controller, Get, Global, HttpCode, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { DeliveryService } from './delivery.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { LogSmsProvider, MailProvider, SmsProvider, SmtpMailProvider } from './providers';
import { latestCutoff } from './templates';

/** FR-22: flag visitors still on premises after the configurable cut-off, once per visit. */
@Injectable()
export class OverstayScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Overstay');
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService, private readonly notifier: NotificationsService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return; // tests call check() directly
    this.timer = setInterval(() => void this.check().catch((e) => this.log.error(e.message)), 5 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async check(now = new Date()): Promise<number> {
    const cutoff = latestCutoff(now, process.env.OVERSTAY_CUTOFF ?? '20:00'); // Asia/Colombo
    const late = await this.prisma.visit.findMany({
      where: { status: 'on_premises', timeIn: { lt: cutoff }, notifications: { none: { event: 'overstay' } } },
      select: { id: true }, take: 500,
    });
    for (const v of late) await this.notifier.visitEvent('overstay', v.id);
    return late.length;
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get() inbox(@CurrentUser() u: AuthUser) {
    return this.svc.inbox(u.id);
  }
  @Post('read-all') @HttpCode(200) readAll(@CurrentUser() u: AuthUser) {
    return this.svc.markRead(u.id);
  }
  @Roles('super_admin') @Get('failed') failed() {
    return this.svc.failed();
  }
  @Roles('super_admin') @Post(':id/retry') @HttpCode(200) retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.retry(id);
  }
  @Post(':id/read') @HttpCode(200) read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.markRead(u.id, id);
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService, NotificationsGateway, DeliveryService, OverstayScheduler,
    { provide: SmsProvider, useClass: LogSmsProvider },
    { provide: MailProvider, useClass: SmtpMailProvider },
  ],
  exports: [NotificationsService, NotificationsGateway, OverstayScheduler],
})
export class NotificationsModule {}
