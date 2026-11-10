import {
  BadRequestException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Query, Res, StreamableFile,
} from '@nestjs/common';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CurrentUser, Roles } from '../common/decorators';
import { PiiCrypto } from '../common/pii-crypto';
import { visitScope } from '../common/scope';
import { DashboardService } from '../dashboard/dashboard.service';
import { Granularity, Period } from '../dashboard/dashboard.rules';
import { PrismaService } from '../prisma/prisma.service';
import { formatColombo } from '../notifications/templates';
import { INCLUDE } from '../visits/visits.service';
import { toView, VisitRecord } from '../visits/visit-rules';
import { Sheet, toPdf, toXlsx } from './export';
import { buildOrderBy, buildWhere, RecordsQuery } from './records.query';

const EXPORT_LIMIT = 10_000;

class ExportQuery extends RecordsQuery {
  @IsEnum(['xlsx', 'pdf']) format: 'xlsx' | 'pdf';
}
class DashboardQuery {
  @IsOptional() @IsUUID() guardRoomId?: string;
  @IsOptional() @IsEnum(['today', '7d', '30d']) period?: Period;
  @IsOptional() @IsEnum(['day', 'week', 'month']) granularity?: Granularity;
}
class DashboardExportQuery extends DashboardQuery {
  @IsEnum(['xlsx', 'pdf']) format: 'xlsx' | 'pdf';
}

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PiiCrypto,
  ) {}

  /** The caller's scope is ANDed in last, so no client filter can widen it (FR-24, NFR-5). */
  private where(actor: AuthUser, q: RecordsQuery) {
    return { AND: [visitScope(actor), buildWhere(q, (n) => this.crypto.hashNic(n))] };
  }

  async list(actor: AuthUser, q: RecordsQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const where = this.where(actor, q);
    const [rows, total] = await Promise.all([
      this.prisma.visit.findMany({
        where, include: INCLUDE, orderBy: buildOrderBy(q.sortBy, q.order), skip: (page - 1) * pageSize, take: pageSize,
      }),
      this.prisma.visit.count({ where }),
    ]);
    return { items: rows.map((v) => toView(v, this.crypto, false)), total, page, pageSize };
  }

  async one(actor: AuthUser, id: string) {
    const v = await this.prisma.visit.findFirst({ where: { AND: [{ id }, visitScope(actor)] }, include: INCLUDE });
    if (!v) throw new NotFoundException('Visit not found');
    return toView(v, this.crypto, true);
  }

  async export(actor: AuthUser, q: ExportQuery): Promise<{ body: Buffer; filename: string; contentType: string }> {
    const rows = await this.prisma.visit.findMany({
      where: this.where(actor, q), include: INCLUDE, orderBy: buildOrderBy(q.sortBy, q.order), take: EXPORT_LIMIT + 1,
    });
    if (rows.length > EXPORT_LIMIT) throw new BadRequestException(`Too many rows (more than ${EXPORT_LIMIT}); narrow the filters`);

    const dt = (d: Date | null) => (d ? formatColombo(d) : '');
    const sheet: Sheet = {
      name: 'Visitor records',
      columns: [
        { header: 'Reference', key: 'ref', width: 20 }, { header: 'Visitor', key: 'name', width: 24 },
        { header: 'NIC / licence (masked)', key: 'nic', width: 18 }, { header: 'Company', key: 'company', width: 22 },
        { header: 'Host', key: 'host', width: 18 }, { header: 'Department', key: 'dept', width: 16 },
        { header: 'Guard room', key: 'room', width: 16 }, { header: 'Pass', key: 'pass', width: 14 },
        { header: 'Status', key: 'status', width: 13 }, { header: 'Source', key: 'source', width: 14, pdf: false },
        { header: 'Expected', key: 'expected', width: 18, pdf: false }, { header: 'Time in', key: 'in', width: 18 },
        { header: 'Time out', key: 'out', width: 18 }, { header: 'Minutes', key: 'mins', width: 9 },
        { header: 'Area visited', key: 'area', width: 20, pdf: false }, { header: 'Purpose', key: 'purpose', width: 24, pdf: false },
      ],
      rows: rows.map((r) => {
        const v = toView(r as VisitRecord, this.crypto, false); // exports never contain a full NIC or phone number
        return {
          ref: v.referenceNo, name: v.visitor.fullName, nic: v.visitor.nic, company: v.visitor.company, host: v.host?.name,
          dept: v.department?.name, room: v.guardRoom.name, pass: v.passCategory?.name, status: v.status, source: v.source,
          expected: dt(v.expectedAt), in: dt(v.timeIn), out: dt(v.timeOut), area: v.areaVisited, purpose: v.purpose,
          mins: v.timeIn && v.timeOut ? Math.round((v.timeOut.getTime() - v.timeIn.getTime()) / 60_000) : '',
        };
      }),
    };
    await this.audit.record({
      userId: actor.id, action: 'export', entity: 'visit',
      after: { format: q.format, rowCount: rows.length, filters: { ...q, format: undefined } },
    });
    return this.pack('visitor-records', q.format, 'Visitor records', `Generated ${formatColombo(new Date())} · ${rows.length} rows`, [sheet]);
  }

  async pack(base: string, format: 'xlsx' | 'pdf', title: string, subtitle: string, sheets: Sheet[]) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return format === 'xlsx'
      ? { body: await toXlsx(sheets), filename: `${base}-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      : { body: await toPdf(title, subtitle, sheets), filename: `${base}-${stamp}.pdf`, contentType: 'application/pdf' };
  }
}

function send(res: Response, f: { body: Buffer; filename: string; contentType: string }) {
  res.set({ 'Content-Type': f.contentType, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'no-store' });
  return new StreamableFile(f.body);
}

/** FR-23 / FR-24 / FR-26: administrators; the service narrows a department admin to their own department. */
@Controller('records')
@Roles('super_admin', 'dept_admin')
export class RecordsController {
  constructor(private readonly svc: RecordsService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: RecordsQuery) {
    return this.svc.list(u, q);
  }
  @Get('export') async export(@CurrentUser() u: AuthUser, @Query() q: ExportQuery, @Res({ passthrough: true }) res: Response) {
    return send(res, await this.svc.export(u, q));
  }
  @Get(':id') one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.one(u, id);
  }
}

/** FR-25 / FR-26. Live updates: screens refetch when the `visits:changed` socket event arrives. */
@Controller('dashboard')
@Roles('super_admin', 'dept_admin')
export class DashboardController {
  constructor(private readonly dash: DashboardService, private readonly records: RecordsService, private readonly audit: AuditService) {}

  @Get() get(@CurrentUser() u: AuthUser, @Query() q: DashboardQuery) {
    return this.dash.get(u, q.period, q.granularity, new Date(), q.guardRoomId);
  }
  @Get('export') async export(@CurrentUser() u: AuthUser, @Query() q: DashboardExportQuery, @Res({ passthrough: true }) res: Response) {
    const d = await this.dash.get(u, q.period, q.granularity, new Date(), q.guardRoomId);
    await this.audit.record({ userId: u.id, action: 'export', entity: 'dashboard', after: { format: q.format, period: d.period } });
    return send(res, await this.records.pack('dashboard', q.format, 'VMS dashboard summary', `Generated ${formatColombo(new Date())}`, DashboardService.sheets(d)));
  }
}

@Module({
  controllers: [RecordsController, DashboardController],
  providers: [RecordsService, DashboardService],
})
export class RecordsModule {}
