import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Global, HttpCode, Injectable,
  Module, NotFoundException, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { CurrentUser, Roles } from '../common/decorators';
import { PiiCrypto } from '../common/pii-crypto';
import { visitScope } from '../common/scope';
import { NotificationsGateway, rooms } from '../notifications/notifications.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { NIC_PATTERN } from '../visits/visit-rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const nicT = ({ value }: { value: unknown }) => (typeof value === 'string' ? PiiCrypto.normaliseNic(value) : value);

export class AddBlacklistDto {
  @Transform(nicT) @Matches(NIC_PATTERN, { message: 'nic must be a valid NIC / licence number' }) nic: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason: string;
}
export class OverrideRequestDto {
  @Transform(nicT) @Matches(NIC_PATTERN, { message: 'nic must be a valid NIC / licence number' }) nic: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) remark: string;
  @IsOptional() @IsUUID() visitId?: string;
}
export class DecisionDto {
  @IsBoolean() approve: boolean;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}
class StatusQuery {
  @IsOptional() @IsEnum(['pending', 'approved', 'rejected', 'used']) status?: string;
}

/** FR-29 / UC-4: single-use administrator approval for a blacklisted visitor. */
@Injectable()
export class OverridesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PiiCrypto,
    private readonly gateway: NotificationsGateway,
  ) {}

  async request(actor: AuthUser, dto: OverrideRequestDto) {
    if (!actor.guardRoomId) throw new ForbiddenException();
    const nicHash = this.crypto.hashNic(dto.nic);
    if (!(await this.prisma.blacklist.findUnique({ where: { nicHash } }))) throw new BadRequestException('This visitor is not blacklisted');
    if (dto.visitId) {
      const v = await this.prisma.visit.findFirst({ where: { AND: [{ id: dto.visitId, status: 'expected' }, visitScope(actor)] } });
      if (!v) throw new NotFoundException('Visit not found');
    }
    const row = await this.prisma.blacklistOverride.create({
      data: { nicHash, guardRoomId: actor.guardRoomId, visitId: dto.visitId, remark: dto.remark, requestedBy: actor.id },
    });
    await this.audit.record({ userId: actor.id, action: 'override_request', entity: 'blacklist_override', entityId: row.id, after: { guardRoomId: row.guardRoomId, remark: row.remark } });
    this.gateway.emit([rooms.admins], 'overrides:changed', { id: row.id, status: row.status });
    return this.publicView(row);
  }

  async status(actor: AuthUser, id: string) {
    const row = await this.prisma.blacklistOverride.findFirst({ where: { id, guardRoomId: actor.guardRoomId ?? '' } });
    if (!row) throw new NotFoundException('Request not found');
    return this.publicView(row);
  }

  list(status?: string) {
    return this.prisma.blacklistOverride.findMany({
      where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, guardRoomId: true, visitId: true, remark: true, status: true, requestedBy: true, decidedBy: true, decisionNote: true, createdAt: true, decidedAt: true },
    });
  }

  async decide(admin: AuthUser, id: string, dto: DecisionDto) {
    const { count } = await this.prisma.blacklistOverride.updateMany({
      where: { id, status: 'pending' },
      data: { status: dto.approve ? 'approved' : 'rejected', decidedBy: admin.id, decisionNote: dto.note, decidedAt: new Date() },
    });
    if (!count) throw new ConflictException('Request not found or already decided');
    const row = await this.prisma.blacklistOverride.findUniqueOrThrow({ where: { id } });
    await this.audit.record({ userId: admin.id, action: dto.approve ? 'override_approve' : 'override_reject', entity: 'blacklist_override', entityId: id, after: { note: dto.note } });
    this.gateway.emit([rooms.guardRoom(row.guardRoomId), rooms.admins], 'overrides:changed', { id, status: row.status });
    return this.publicView(row);
  }

  /** Spend an approval inside the caller's transaction; it must match this visitor and this guard room, once. */
  async consume(tx: Prisma.TransactionClient, id: string, nicHash: string, guardRoomId: string, actorId: string) {
    const { count } = await tx.blacklistOverride.updateMany({
      where: { id, status: 'approved', nicHash, guardRoomId }, data: { status: 'used' },
    });
    if (!count) throw new ForbiddenException('No valid administrator approval for this blacklisted visitor');
    await this.audit.record({ userId: actorId, action: 'override_used', entity: 'blacklist_override', entityId: id });
  }

  private publicView = (r: { id: string; status: string; remark: string; decisionNote: string | null; createdAt: Date }) =>
    ({ id: r.id, status: r.status, remark: r.remark, decisionNote: r.decisionNote, createdAt: r.createdAt });
}

@Controller('blacklist')
@Roles('super_admin')
export class BlacklistController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly crypto: PiiCrypto, private readonly overrides: OverridesService) {}

  @Get() list() {
    return this.prisma.blacklist.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, nicMasked: true, reason: true, createdAt: true } });
  }

  @Post() async add(@CurrentUser() u: AuthUser, @Body() dto: AddBlacklistDto) {
    try {
      const row = await this.prisma.blacklist.create({
        data: { nicHash: this.crypto.hashNic(dto.nic), nicMasked: PiiCrypto.mask(dto.nic), reason: dto.reason, addedBy: u.id },
        select: { id: true, nicMasked: true, reason: true, createdAt: true },
      });
      await this.audit.record({ userId: u.id, action: 'create', entity: 'blacklist', entityId: row.id, after: row });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Already blacklisted');
      throw e;
    }
  }

  @Delete(':id') @HttpCode(204) async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.prisma.blacklist.findUnique({ where: { id }, select: { id: true, nicMasked: true, reason: true } });
    if (!row) throw new NotFoundException();
    await this.prisma.blacklist.delete({ where: { id } });
    await this.audit.record({ userId: u.id, action: 'delete', entity: 'blacklist', entityId: id, before: row });
  }

  @Get('overrides/requests') requests(@Query() q: StatusQuery) {
    return this.overrides.list(q.status);
  }
  @Post('overrides/:id/decision') @HttpCode(200) decide(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.overrides.decide(u, id, dto);
  }
}

@Global()
@Module({ controllers: [BlacklistController], providers: [OverridesService], exports: [OverridesService] })
export class BlacklistModule {}
