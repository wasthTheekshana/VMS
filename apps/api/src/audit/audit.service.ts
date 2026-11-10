import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Roles } from '../common/decorators';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const REDACTED_KEYS = new Set(['passwordHash', 'password_hash', 'password']);

/** Strip secrets so they can never land in the audit log. */
export function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (k, v) => (REDACTED_KEYS.has(k) ? '[redacted]' : v)),
  ) as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Append-only (a DB trigger blocks UPDATE/DELETE - see migration). FR-28, NFR-10. */
  async record(entry: {
    userId?: string | null;
    action: string;
    entity: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
  }) {
    await this.prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        beforeJson: sanitize(entry.before),
        afterJson: sanitize(entry.after),
      },
    });
  }
}

class AuditQuery {
  @IsOptional() @IsString() @MaxLength(60) entity?: string;
  @IsOptional() @IsString() @MaxLength(60) action?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

/** FR-28: read-only view for the Super Administrator. There is deliberately no write endpoint. */
@Controller('audit')
@Roles('super_admin')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get() async list(@Query() q: AuditQuery) {
    const day = 86_400_000;
    const off = 5.5 * 3600_000;
    const start = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) - off);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entity && { entity: q.entity }), ...(q.action && { action: q.action }), ...(q.userId && { userId: q.userId }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: start(q.from) }), ...(q.to && { lt: new Date(start(q.to).getTime() + day) }) } }),
    };
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.auditLog.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    return { total, page, pageSize, items: rows.map((r) => ({ ...r, userName: r.userId ? name.get(r.userId) ?? null : null })) };
  }
}

@Global()
@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
