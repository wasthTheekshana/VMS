import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

/**
 * Field-level protection for NIC / licence numbers (NFR-4, PDPA).
 *  - encrypt/decrypt: AES-256-GCM, random 96-bit IV, output "v1.<iv>.<tag>.<ciphertext>" (base64url)
 *  - hashNic: HMAC-SHA256 of the normalised value, for equality lookup & blacklist without decrypting
 */
export class PiiCrypto {
  private readonly key: Buffer;
  constructor(base64Key: string, private readonly hmacKey: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  }

  static normaliseNic(nic: string): string {
    return nic.replace(/[\s-]/g, '').toUpperCase();
  }

  hashNic(nic: string): string {
    return createHmac('sha256', this.hmacKey).update(PiiCrypto.normaliseNic(nic)).digest('hex');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, ct] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised ciphertext format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  /** "199512345678" -> "********5678": last four only; the leading digits of a NIC encode birth year and day. */
  static mask(nic: string): string {
    const n = PiiCrypto.normaliseNic(nic);
    return n.length <= 4 ? '*'.repeat(n.length) : `${'*'.repeat(n.length - 4)}${n.slice(-4)}`;
  }
}
