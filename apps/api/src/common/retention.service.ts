import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const DAY = 86_400_000;

/**
 * NFR-9: visitor records are kept for a configurable period (default 3 years), then purged so personal data
 * is not held longer than needed (PDPA storage limitation). The audit log is append-only and is NOT purged here;
 * its retention is a database-administration task (see README).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.purge().catch((e) => this.log.error(e.message)), DAY);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  static retentionDays(env = process.env): number {
    const n = Number(env.RETENTION_DAYS ?? 1095);
    if (!Number.isInteger(n) || n < 30) throw new Error('RETENTION_DAYS must be an integer of at least 30');
    return n;
  }

  /** Only finished visits (checked out / cancelled) are purged; anything still open is never deleted. */
  async purge(now = new Date(), days = RetentionService.retentionDays()) {
    const cutoff = new Date(now.getTime() - days * DAY);
    const old = { createdAt: { lt: cutoff }, status: { in: ['checked_out', 'cancelled'] as ('checked_out' | 'cancelled')[] } };
    const notifications = await this.prisma.notification.deleteMany({ where: { visit: old } });
    const visits = await this.prisma.visit.deleteMany({ where: old });
    await this.prisma.visitGroup.deleteMany({ where: { createdAt: { lt: cutoff }, visits: { none: {} } } });
    const visitors = await this.prisma.visitor.deleteMany({ where: { createdAt: { lt: cutoff }, visits: { none: {} } } });
    if (visits.count || visitors.count) {
      await this.audit.record({ action: 'retention_purge', entity: 'visit', after: { cutoff, visits: visits.count, visitors: visitors.count, notifications: notifications.count } });
    }
    return { visits: visits.count, visitors: visitors.count };
  }
}

@Global()
@Module({ providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
