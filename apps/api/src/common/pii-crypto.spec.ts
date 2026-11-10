import { randomBytes } from 'crypto';
import { PiiCrypto } from './pii-crypto';

const key = randomBytes(32).toString('base64');
const c = new PiiCrypto(key, 'x'.repeat(32));

describe('PiiCrypto', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = c.encrypt('199512345678');
    expect(a).not.toContain('199512345678');
    expect(c.decrypt(a)).toBe('199512345678');
    expect(c.encrypt('199512345678')).not.toBe(a);
  });

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, ct] = c.encrypt('123456789V').split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => c.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('rejects a wrong key', () => {
    const other = new PiiCrypto(randomBytes(32).toString('base64'), 'y'.repeat(32));
    expect(() => other.decrypt(c.encrypt('123456789V'))).toThrow();
  });

  it('hashes equivalent NIC spellings identically', () => {
    expect(c.hashNic('123456789v')).toBe(c.hashNic(' 123456789V '));
    expect(c.hashNic('123456789V')).not.toBe(c.hashNic('123456780V'));
  });

  it('masks all but the last four characters', () => {
    expect(PiiCrypto.mask('199512345678')).toBe('********5678');
    expect(PiiCrypto.mask('123456789V')).toBe('******789V');
    expect(PiiCrypto.mask('1234')).toBe('****');
  });

  it('refuses a short key', () => {
    expect(() => new PiiCrypto(Buffer.alloc(16).toString('base64'), 'x'.repeat(32))).toThrow();
  });
});
