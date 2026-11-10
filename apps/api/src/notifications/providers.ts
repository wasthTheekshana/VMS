import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';

/** SMS gateway port. The real gateway (Dialog / Mobitel / Notify.lk) is a client decision; only this adapter changes. */
export abstract class SmsProvider {
  abstract send(toE164: string, text: string): Promise<void>;
}

export abstract class MailProvider {
  abstract send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

const mask = (s: string) => (s.length <= 4 ? '****' : `${'*'.repeat(s.length - 4)}${s.slice(-4)}`);

/** Default until a gateway account exists: logs a masked recipient and the length only, never the message body. */
@Injectable()
export class LogSmsProvider extends SmsProvider {
  private readonly log = new Logger('SMS');
  async send(to: string, text: string) {
    this.log.warn(`SMS gateway not configured; NOT sent to ${mask(to)} (${text.length} chars)`);
  }
}

@Injectable()
export class SmtpMailProvider extends MailProvider {
  private readonly log = new Logger('Mail');
  private readonly transport = process.env.SMTP_HOST
    ? createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        requireTLS: process.env.SMTP_SECURE !== 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      })
    : null;

  async send(msg: { to: string; subject: string; text: string }) {
    if (!this.transport) {
      this.log.warn(`SMTP not configured; NOT sent to ${mask(msg.to)}`);
      return;
    }
    await this.transport.sendMail({ from: process.env.SMTP_FROM ?? 'vms@localhost', ...msg });
  }
}
