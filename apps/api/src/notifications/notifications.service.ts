import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryService } from './delivery.service';
import { NotificationsGateway, rooms } from './notifications.gateway';
import { clean, hostSms, inAppText, MessageCtx, toE164LK, VisitEvent, visitorSms } from './templates';

export interface EventOptions {
  /** Guard room the visit was moved away from; its guards are told too. */
  previousGuardRoomId?: string;
  /** Edited date/time or guard room => the visitor receives an SMS. */
  notifyVisitor?: boolean;
}

type Draft = Prisma.NotificationCreateManyInput;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
    private readonly gateway: NotificationsGateway,
  ) {}

  private async userIds(where: Prisma.UserWhereInput) {
    return (await this.prisma.user.findMany({ where: { ...where, isActive: true }, select: { id: true } })).map((u) => u.id);
  }

  /**
   * One call per visit change. Persists per-recipient notifications, pushes in-app alerts over WebSocket,
   * queues SMS / e-mail, and tells open screens to refresh. Never throws into the caller's business flow.
   */
  async visitEvent(event: VisitEvent, visitId: string, opts: EventOptions = {}) {
    try {
      await this.dispatch(event, visitId, opts);
    } catch (e) {
      this.log.error(`event ${event} for ${visitId} failed: ${(e as Error).message}`);
    }
  }

  private async dispatch(event: VisitEvent, visitId: string, opts: EventOptions) {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true, referenceNo: true, expectedAt: true, guardRoomId: true, departmentId: true, hostUserId: true,
        visitor: { select: { fullName: true, phone: true } },
        guardRoom: { select: { name: true } },
        host: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!visit) return;
    const ctx: MessageCtx = {
      referenceNo: visit.referenceNo, visitorName: visit.visitor.fullName, hostName: visit.host?.name,
      guardRoomName: visit.guardRoom.name, expectedAt: visit.expectedAt,
    };
    const { title, message } = inAppText(event, ctx);
    const roomIds = [visit.guardRoomId, ...(opts.previousGuardRoomId ? [opts.previousGuardRoomId] : [])];

    // Who gets an in-app alert; `sound` marks guard-room alerts (FR-19).
    const alerts = new Map<string, boolean>();
    const add = (ids: string[], sound = false) => ids.forEach((id) => alerts.set(id, (alerts.get(id) ?? false) || sound));
    const admins = () => this.userIds({ role: 'super_admin' });
    const guards = () => this.userIds({ role: 'guard', guardRoomId: { in: roomIds } });
    switch (event) {
      case 'pre_registered': case 'pre_registration_updated': case 'pre_registration_cancelled': case 'overstay':
        add(await admins()); add(await guards(), true); break;
      case 'walk_in': add(await admins()); break;
      case 'blacklist_hit': add(await admins()); break;
      case 'checked_in': case 'checked_out': break; // admins see these as a dashboard update only
    }
    if (visit.host && ['walk_in', 'checked_in', 'checked_out'].includes(event)) add([visit.host.id]);

    const drafts: Draft[] = [];
    for (const [uid, sound] of alerts) {
      drafts.push({ visitId, recipientUserId: uid, channel: 'in_app', event, status: 'sent', sentAt: new Date(), payload: { title, message, sound } });
    }
    const queued: Draft[] = [];
    const smsDraft = (phone: string | null | undefined, text: string, userId?: string): Draft => {
      const to = toE164LK(phone);
      return {
        visitId, recipientUserId: userId, recipientPhone: to ?? phone ?? null, channel: 'sms', event, payload: { text },
        ...(to ? { status: 'pending' } : { status: 'failed', lastError: 'invalid or missing phone number' }),
      };
    };
    if (event === 'pre_registered' || event === 'pre_registration_cancelled' || (event === 'pre_registration_updated' && opts.notifyVisitor)) {
      if (visit.visitor.phone) queued.push(smsDraft(visit.visitor.phone, visitorSms(event as never, ctx)));
    }
    if ((event === 'checked_in' || event === 'walk_in') && visit.host) {
      queued.push(smsDraft(visit.host.phone, hostSms(event, ctx), visit.host.id));
    }
    if (event === 'blacklist_hit') {
      const adminUsers = await this.prisma.user.findMany({ where: { role: 'super_admin', isActive: true, email: { not: null } }, select: { id: true, email: true } });
      for (const a of adminUsers) {
        queued.push({
          visitId, recipientUserId: a.id, channel: 'email', event, status: 'pending',
          payload: { to: a.email, subject: `VMS: ${title}`, text: clean(message) },
        });
      }
    }

    const created = await this.prisma.notification.createManyAndReturn({ data: [...drafts, ...queued] });
    for (const row of created) {
      if (row.channel === 'in_app') {
        const p = row.payload as { title: string; message: string; sound: boolean };
        this.gateway.emit([rooms.user(row.recipientUserId!)], 'notification', {
          id: row.id, event, visitId, title: p.title, message: p.message, sound: p.sound, createdAt: row.createdAt,
        });
      } else if (row.status === 'pending') {
        await this.delivery.enqueue(row.id).catch((e) => this.log.error(`enqueue failed: ${e.message}`)); // stays pending; recovered at boot
      }
    }

    // Screens re-fetch their lists on this signal (also what makes reconnect self-healing).
    const targets = [rooms.admins, ...roomIds.map(rooms.guardRoom)];
    if (visit.departmentId) targets.push(rooms.dept(visit.departmentId));
    if (visit.hostUserId) targets.push(rooms.user(visit.hostUserId));
    this.gateway.emit(targets, 'visits:changed', { visitId, event });
  }

  // ---------- inbox ----------

  inbox(userId: string) {
    return this.prisma.notification.findMany({
      where: { recipientUserId: userId, channel: 'in_app' },
      orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, event: true, visitId: true, payload: true, readAt: true, createdAt: true },
    });
  }

  async markRead(userId: string, id?: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, channel: 'in_app', readAt: null, ...(id && { id }) }, // own rows only
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  // ---------- admin: failed deliveries ----------

  failed() {
    return this.prisma.notification.findMany({
      where: { status: 'failed', channel: { in: ['sms', 'email'] as NotificationChannel[] } },
      orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, visitId: true, channel: true, event: true, attempts: true, lastError: true, createdAt: true },
    });
  }

  async retry(id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, status: 'failed', recipientPhone: { not: null } }, data: { status: 'pending', attempts: 0, lastError: null },
    });
    const emailCount = count ? 0 : (await this.prisma.notification.updateMany({
      where: { id, status: 'failed', channel: 'email' }, data: { status: 'pending', attempts: 0, lastError: null },
    })).count;
    if (!count && !emailCount) return { requeued: false };
    await this.delivery.enqueue(id);
    return { requeued: true };
  }
}
