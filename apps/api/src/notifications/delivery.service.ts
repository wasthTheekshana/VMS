import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { MailProvider, SmsProvider } from './providers';

const QUEUE = 'vms-delivery';
const MAX_ATTEMPTS = 3; // plan: retry 3 times with back-off, then mark failed for admins

/**
 * SMS / e-mail delivery runs off the request path, so a slow gateway never blocks a guard.
 * The job id is the notification id, which makes enqueueing idempotent.
 */
@Injectable()
export class DeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Delivery');
  private connection!: IORedis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsProvider,
    private readonly mail: MailProvider,
  ) {}

  async onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is required');
    // BullMQ requires maxRetriesPerRequest: null on its blocking connection.
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE, { connection: this.connection });
    this.worker = new Worker(QUEUE, (job) => this.process(job), { connection: this.connection, concurrency: 5 });
    this.worker.on('error', (e) => this.log.error(`worker error: ${e.message}`));
    await this.requeuePending(); // crash recovery: rows that never reached Redis
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  async enqueue(notificationId: string) {
    await this.queue.add('send', { notificationId }, {
      jobId: notificationId,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: Number(process.env.NOTIFY_BACKOFF_MS ?? 5000) },
      removeOnComplete: true,
      removeOnFail: true, // the notifications table is the durable record
    });
  }

  private async requeuePending() {
    const rows = await this.prisma.notification.findMany({
      where: { status: 'pending', channel: { in: ['sms', 'email'] } }, select: { id: true }, take: 1000,
    });
    for (const r of rows) await this.enqueue(r.id).catch(() => undefined);
  }

  private async process(job: Job<{ notificationId: string }>) {
    const n = await this.prisma.notification.findUnique({ where: { id: job.data.notificationId } });
    if (!n || n.status === 'sent') return;
    await this.prisma.notification.update({ where: { id: n.id }, data: { attempts: { increment: 1 } } });
    const p = (n.payload ?? {}) as { text?: string; subject?: string; to?: string };
    try {
      if (n.channel === 'sms') {
        if (!n.recipientPhone || !p.text) throw new Error('missing phone or text');
        await this.sms.send(n.recipientPhone, p.text);
      } else if (n.channel === 'email') {
        if (!p.to || !p.text) throw new Error('missing recipient or text');
        await this.mail.send({ to: p.to, subject: p.subject ?? 'VMS notification', text: p.text });
      }
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'sent', sentAt: new Date(), lastError: null } });
    } catch (e) {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? MAX_ATTEMPTS);
      await this.prisma.notification.update({
        where: { id: n.id },
        data: { status: final ? 'failed' : 'pending', lastError: String((e as Error).message).slice(0, 300) },
      });
      throw e; // lets BullMQ schedule the retry
    }
  }
}
