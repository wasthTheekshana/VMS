import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { PiiCrypto } from '../common/pii-crypto';
import { NotificationsService } from '../notifications/notifications.service';
import { OverridesService } from '../blacklist/blacklist.module';
import { visitScope } from '../common/scope';
import {
  CheckInDto, CheckOutDto, PreRegisterDto, UpdatePreRegistrationDto, WalkInDto,
} from './visits.dto';
import { colomboDayBounds, isValidNic, newReferenceNo, toHostView, toView, VisitRecord } from './visit-rules';

/** Explicit selects: the NIC hash and any ciphertext must never be serialised to clients. */
export const INCLUDE = {
  visitor: { select: { id: true, fullName: true, nicOrLicence: true, phone: true, company: true, address: true } },
  guardRoom: { select: { id: true, name: true } },
  passCategory: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  host: { select: { id: true, name: true } },
} satisfies Prisma.VisitInclude;

const LIST_LIMIT = 200;
type Tx = Prisma.TransactionClient;

@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PiiCrypto,
    private readonly notifier: NotificationsService,
    private readonly overrides: OverridesService,
  ) {}

  private view = (v: VisitRecord, full = false) => toView(v, this.crypto, full);
  /** Hosts and department admins only ever see what is recorded on the visit itself, never the shared visitor record. */
  private hostView = (v: VisitRecord, full = false) => toHostView(v, this.crypto, full);
  /** Audit entries carry ids and statuses only: strip the visitor and the per-visit copies of name/phone/company. */
  private auditable = <T extends object>(v: T) => ({ ...v, visitor: undefined, visitorName: undefined, visitorPhone: undefined, visitorCompany: undefined });

  // ---------- shared helpers ----------

  private async requireActive(kind: 'guardRoom' | 'passCategory' | 'department', id: string, label: string) {
    const row = await (this.prisma[kind] as any).findUnique({ where: { id } });
    if (!row?.isActive) throw new BadRequestException(`${label} not found or inactive`);
  }

  /** Find or create a visitor by NIC hash. `overwrite` = the caller has verified the ID document in person. */
  private async upsertVisitor(
    tx: Tx, v: { fullName?: string; nic: string; phone?: string; company?: string; address?: string }, overwrite: boolean,
  ) {
    const nicHash = this.crypto.hashNic(v.nic);
    const existing = await tx.visitor.findUnique({ where: { nicHash } });
    if (!existing) {
      if (!v.fullName) throw new BadRequestException('fullName is required for a new visitor');
      return tx.visitor.create({
        data: {
          fullName: v.fullName, nicHash, nicOrLicence: this.crypto.encrypt(PiiCrypto.normaliseNic(v.nic)),
          phone: v.phone, company: v.company, address: v.address,
        },
      });
    }
    // A host pre-registering a NIC that is already on file must not touch the shared record: it holds data other
    // hosts and guards entered. Their typed details live on the visit itself (see visitorName/Phone/Company).
    if (!overwrite) return existing;
    const data: Prisma.VisitorUpdateInput = {};
    if (v.phone) data.phone = v.phone;
    if (v.company) data.company = v.company;
    if (v.fullName) data.fullName = v.fullName;
    if (v.address) data.address = v.address;
    return Object.keys(data).length ? tx.visitor.update({ where: { id: existing.id }, data }) : existing;
  }

  private async isBlacklisted(...hashes: string[]) {
    return (await this.prisma.blacklist.count({ where: { nicHash: { in: hashes } } })) > 0;
  }

  private async createVisit(tx: Tx, data: Omit<Prisma.VisitUncheckedCreateInput, 'referenceNo'>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await tx.visit.create({ data: { ...data, referenceNo: newReferenceNo() }, include: INCLUDE });
      } catch (e) {
        const collision = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!collision || attempt >= 4) throw e;
      }
    }
  }

  /** A record the actor may see, or 404 (never 403: do not reveal that it exists in another scope). */
  private async findScoped(actor: AuthUser, id: string) {
    const v = await this.prisma.visit.findFirst({ where: { id, ...visitScope(actor) }, include: INCLUDE });
    if (!v) throw new NotFoundException('Visit not found');
    return v;
  }

  // ---------- Host (FR-7, FR-8, FR-9) ----------

  async preRegister(actor: AuthUser, dto: PreRegisterDto) {
    if (!actor.departmentId) throw new ForbiddenException();
    if (dto.expectedAt < colomboDayBounds().start) throw new BadRequestException('expectedAt cannot be in the past');
    const nics = dto.visitors.map((v) => this.crypto.hashNic(v.nic));
    if (new Set(nics).size !== nics.length) throw new BadRequestException('Duplicate NIC in visitors list');
    await this.requireActive('guardRoom', dto.guardRoomId, 'Guard room');
    await this.requireActive('department', actor.departmentId, 'Department');

    const visits = await this.prisma.$transaction(async (tx) => {
      const group = dto.visitors.length > 1
        ? await tx.visitGroup.create({ data: { hostUserId: actor.id, purpose: dto.purpose } })
        : null;
      const out: Awaited<ReturnType<VisitsService['createVisit']>>[] = [];
      for (const input of dto.visitors) {
        const visitor = await this.upsertVisitor(tx, input, false);
        out.push(await this.createVisit(tx, {
          visitorId: visitor.id, groupId: group?.id, hostUserId: actor.id, departmentId: actor.departmentId,
          guardRoomId: dto.guardRoomId, purpose: dto.purpose, areaVisited: dto.areaVisited,
          expectedAt: dto.expectedAt, status: 'expected', source: 'pre_registered', createdBy: actor.id,
          visitorName: input.fullName, visitorPhone: input.phone, visitorCompany: input.company, // the host's own entries
        }));
      }
      return out;
    });

    for (const v of visits) {
      await this.audit.record({ userId: actor.id, action: 'pre_register', entity: 'visit', entityId: v.id, after: this.auditable(v) });
    }
    // UC-2: warn (do not block) when a pre-registered visitor is blacklisted.
    const listed = await this.prisma.blacklist.findMany({ where: { nicHash: { in: nics } }, select: { nicHash: true } });
    const flagged = new Set(listed.map((b) => b.nicHash));
    for (let i = 0; i < visits.length; i++) {
      await this.notifier.visitEvent('pre_registered', visits[i].id);
      if (flagged.has(nics[i])) await this.notifier.visitEvent('blacklist_hit', visits[i].id);
    }
    return {
      visits: visits.map((v, i) => ({ ...this.hostView(v), blacklisted: flagged.has(nics[i]) })),
    };
  }

  async listMine(actor: AuthUser) {
    const rows = await this.prisma.visit.findMany({
      where: visitScope(actor), include: INCLUDE, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT,
    });
    return rows.map((v) => this.hostView(v));
  }

  /** Guards verify identity from the shared record; hosts and department admins only see this visit's own details. */
  async getOne(actor: AuthUser, id: string) {
    const v = await this.findScoped(actor, id);
    return actor.role === 'guard' ? this.view(v, true) : this.hostView(v, true);
  }

  async updatePreRegistration(actor: AuthUser, id: string, dto: UpdatePreRegistrationDto) {
    const before = await this.findScoped(actor, id);
    if (before.source !== 'pre_registered' || before.status !== 'expected') {
      throw new ConflictException('Only an expected pre-registration can be edited');
    }
    if (dto.expectedAt && dto.expectedAt < colomboDayBounds().start) throw new BadRequestException('expectedAt cannot be in the past');
    if (dto.guardRoomId) await this.requireActive('guardRoom', dto.guardRoomId, 'Guard room');
    const { count } = await this.prisma.visit.updateMany({ where: { id, status: 'expected' }, data: dto });
    if (!count) throw new ConflictException('Visit changed; reload and retry');
    const after = await this.findScoped(actor, id);
    await this.audit.record({
      userId: actor.id, action: 'update', entity: 'visit', entityId: id,
      before: this.auditable(before), after: this.auditable(after),
    });
    const roomChanged = after.guardRoom.id !== before.guardRoom.id;
    const timeChanged = (after.expectedAt?.getTime() ?? 0) !== (before.expectedAt?.getTime() ?? 0);
    await this.notifier.visitEvent('pre_registration_updated', id, {
      previousGuardRoomId: roomChanged ? before.guardRoom.id : undefined, notifyVisitor: roomChanged || timeChanged,
    });
    return this.hostView(after);
  }

  async cancel(actor: AuthUser, id: string) {
    const before = await this.findScoped(actor, id);
    if (before.status !== 'expected') throw new ConflictException('Only an expected visit can be cancelled');
    const { count } = await this.prisma.visit.updateMany({ where: { id, status: 'expected' }, data: { status: 'cancelled' } });
    if (!count) throw new ConflictException('Visit changed; reload and retry');
    await this.audit.record({ userId: actor.id, action: 'cancel', entity: 'visit', entityId: id, before: { status: before.status }, after: { status: 'cancelled' } });
    await this.notifier.visitEvent('pre_registration_cancelled', id);
    return this.hostView(await this.findScoped(actor, id));
  }

  // ---------- Guard console (FR-10 to FR-16, FR-17) ----------

  private searchClause(q?: string): Prisma.VisitWhereInput {
    const term = q?.trim();
    if (!term) return {};
    const or: Prisma.VisitWhereInput[] = [
      { referenceNo: { contains: term.toUpperCase() } },
      { visitor: { fullName: { contains: term, mode: 'insensitive' } } },
      { visitor: { phone: { contains: term } } },
    ];
    if (isValidNic(term)) or.push({ visitor: { nicHash: this.crypto.hashNic(term) } });
    return { OR: or };
  }

  async expectedToday(actor: AuthUser, q?: string) {
    const { start, end } = colomboDayBounds();
    const rows = await this.prisma.visit.findMany({
      where: { AND: [visitScope(actor), { status: 'expected', expectedAt: { gte: start, lt: end } }, this.searchClause(q)] },
      include: INCLUDE, orderBy: { expectedAt: 'asc' }, take: LIST_LIMIT,
    });
    return rows.map((v) => this.view(v));
  }

  async onPremises(actor: AuthUser, q?: string) {
    const rows = await this.prisma.visit.findMany({
      where: { AND: [visitScope(actor), { status: 'on_premises' }, this.searchClause(q)] },
      include: INCLUDE, orderBy: { timeIn: 'asc' }, take: LIST_LIMIT,
    });
    return rows.map((v) => this.view(v));
  }

  /** The signed-in guard's own check-outs for one Colombo day (default today). Never includes other guards' exits. */
  async myExits(actor: AuthUser, date?: string) {
    const { start, end } = colomboDayBounds(date ? new Date(`${date}T12:00:00+05:30`) : new Date());
    const rows = await this.prisma.visit.findMany({
      where: { checkedOutBy: actor.id, timeOut: { gte: start, lt: end } },
      include: INCLUDE, orderBy: { timeOut: 'desc' }, take: LIST_LIMIT,
    });
    const mins = rows.map((v) => (v.timeIn ? Math.round((v.timeOut!.getTime() - v.timeIn.getTime()) / 60_000) : 0));
    return {
      date: start.toISOString(),
      total: rows.length,
      avgMinutes: rows.length ? Math.round(mins.reduce((a, b) => a + b, 0) / rows.length) : 0,
      firstExit: rows.length ? rows[rows.length - 1].timeOut : null,
      lastExit: rows.length ? rows[0].timeOut : null,
      exits: rows.map((v, i) => ({ ...this.view(v), durationMinutes: mins[i] })),
    };
  }

  /** FR-16 returning-visitor auto-fill + FR-29 warning. Guard sees stored details because they are verifying the ID in hand. */
  async lookup(nic: string) {
    if (!isValidNic(nic)) throw new BadRequestException('Invalid NIC / licence number');
    const hash = this.crypto.hashNic(nic);
    const [visitor, blacklisted] = await Promise.all([
      this.prisma.visitor.findUnique({ where: { nicHash: hash }, select: { fullName: true, address: true, phone: true, company: true } }),
      this.isBlacklisted(hash),
    ]);
    return { found: !!visitor, visitor, blacklisted };
  }

  async checkIn(actor: AuthUser, id: string, dto: CheckInDto) {
    const visit = await this.findScoped(actor, id); // guard-room segregation (FR-17)
    if (visit.status !== 'expected') throw new ConflictException(`Visit is already ${visit.status}`);
    await this.requireActive('passCategory', dto.passCategoryId, 'Pass category');

    const currentNic = this.crypto.decrypt(visit.visitor.nicOrLicence);
    const finalNic = dto.nic ?? currentNic;
    const finalHash = this.crypto.hashNic(finalNic);
    const blacklisted = await this.isBlacklisted(finalHash);
    if (blacklisted && !dto.overrideId) {
      await this.audit.record({ userId: actor.id, action: 'blocked_blacklisted', entity: 'visit', entityId: id });
      await this.notifier.visitEvent('blacklist_hit', id);
      throw new ForbiddenException('Visitor is blacklisted; administrator approval is required');
    }

    await this.prisma.$transaction(async (tx) => {
      if (blacklisted) await this.overrides.consume(tx, dto.overrideId!, finalHash, actor.guardRoomId!, actor.id);
      const visitor = await this.upsertVisitor(tx, { ...dto, nic: finalNic, fullName: dto.fullName ?? visit.visitor.fullName }, true);
      const { count } = await tx.visit.updateMany({
        where: { id, status: 'expected' }, // atomic: a double tap cannot check in twice
        data: {
          status: 'on_premises', timeIn: new Date(), visitorId: visitor.id, passCategoryId: dto.passCategoryId,
          // the guard-verified details become this visit's own record (what its host will see)
          visitorName: visitor.fullName, visitorPhone: visitor.phone, visitorCompany: visitor.company,
          ...(dto.areaVisited && { areaVisited: dto.areaVisited }), ...(dto.remarks && { remarks: dto.remarks }),
        },
      });
      if (!count) throw new ConflictException('Visit was already checked in');
    });

    const after = await this.findScoped(actor, id);
    await this.audit.record({
      userId: actor.id, action: 'check_in', entity: 'visit', entityId: id,
      before: { status: visit.status, visitorId: visit.visitor.id }, after: { status: after.status, timeIn: after.timeIn, visitorId: after.visitor.id },
    });
    await this.notifier.visitEvent('checked_in', id);
    return this.view(after, true);
  }

  async walkIn(actor: AuthUser, dto: WalkInDto) {
    if (!actor.guardRoomId) throw new ForbiddenException();
    await this.requireActive('guardRoom', actor.guardRoomId, 'Guard room');
    await this.requireActive('department', dto.hostDepartmentId, 'Department');
    await this.requireActive('passCategory', dto.passCategoryId, 'Pass category');
    if (dto.hostUserId) {
      const host = await this.prisma.user.findFirst({
        where: { id: dto.hostUserId, role: 'host', isActive: true, departmentId: dto.hostDepartmentId },
      });
      if (!host) throw new BadRequestException('Host not found in that department');
    }
    const walkHash = this.crypto.hashNic(dto.nic);
    const blacklisted = await this.isBlacklisted(walkHash);
    if (blacklisted && !dto.overrideId) {
      await this.audit.record({ userId: actor.id, action: 'blocked_blacklisted', entity: 'visit', after: { source: 'walk_in', guardRoomId: actor.guardRoomId } });
      throw new ForbiddenException('Visitor is blacklisted; administrator approval is required');
    }

    const visit = await this.prisma.$transaction(async (tx) => {
      if (blacklisted) await this.overrides.consume(tx, dto.overrideId!, walkHash, actor.guardRoomId!, actor.id);
      const visitor = await this.upsertVisitor(tx, dto, true);
      return this.createVisit(tx, {
        visitorId: visitor.id, hostUserId: dto.hostUserId, departmentId: dto.hostDepartmentId, guardRoomId: actor.guardRoomId!,
        passCategoryId: dto.passCategoryId, purpose: dto.purpose, areaVisited: dto.areaVisited, remarks: dto.remarks,
        status: 'on_premises', source: 'walk_in', timeIn: new Date(), createdBy: actor.id,
        visitorName: visitor.fullName, visitorPhone: visitor.phone, visitorCompany: visitor.company,
      });
    });
    await this.audit.record({ userId: actor.id, action: 'walk_in', entity: 'visit', entityId: visit.id, after: this.auditable(visit) });
    await this.notifier.visitEvent('walk_in', visit.id);
    return this.view(visit, true);
  }

  /** Names only: lets a guard pick the host on a walk-in without being able to browse user accounts. */
  hosts(departmentId: string) {
    return this.prisma.user.findMany({
      where: { role: 'host', isActive: true, departmentId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500,
    });
  }

  /** FR-27: the minimum a printed pass needs. No NIC, no phone. */
  async slip(actor: AuthUser, id: string) {
    const v = await this.findScoped(actor, id);
    if (v.status !== 'on_premises' && v.status !== 'checked_out') throw new ConflictException('Visitor has not checked in');
    return {
      referenceNo: v.referenceNo, visitorName: v.visitor.fullName, company: v.visitor.company, passCategory: v.passCategory?.name ?? null,
      host: v.host?.name ?? null, department: v.department?.name ?? null, areaVisited: v.areaVisited, guardRoom: v.guardRoom.name, timeIn: v.timeIn,
    };
  }

  async checkOut(actor: AuthUser, id: string, dto: CheckOutDto) {
    // Cross-gate check-out is an open client question (plan); default is the visitor's own guard room only.
    const visit = await this.findScoped(actor, id);
    if (visit.status !== 'on_premises') throw new ConflictException(`Visit is ${visit.status}, not on premises`);
    const remarks = dto.remarks ? [visit.remarks, dto.remarks].filter(Boolean).join('\n') : undefined;
    const { count } = await this.prisma.visit.updateMany({
      where: { id, status: 'on_premises' }, data: { status: 'checked_out', timeOut: new Date(), checkedOutBy: actor.id, ...(remarks && { remarks }) },
    });
    if (!count) throw new ConflictException('Visit was already checked out');
    const after = await this.findScoped(actor, id);
    await this.audit.record({
      userId: actor.id, action: 'check_out', entity: 'visit', entityId: id,
      before: { status: visit.status }, after: { status: after.status, timeOut: after.timeOut },
    });
    await this.notifier.visitEvent('checked_out', id);
    const durationMinutes = Math.round((after.timeOut!.getTime() - after.timeIn!.getTime()) / 60_000);
    return { ...this.view(after, true), durationMinutes };
  }
}
