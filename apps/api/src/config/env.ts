export interface Env {
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  webOrigin: string;
  cookieSecure: boolean;
}

/** Fail fast at boot if a security-critical setting is missing or weak. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const jwtSecret = source.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  for (const k of ['DATABASE_URL', 'REDIS_URL', 'DATA_ENCRYPTION_KEY', 'NIC_HASH_KEY']) {
    if (!source[k]) throw new Error(`${k} is required`);
  }
  if (Buffer.from(source.DATA_ENCRYPTION_KEY!, 'base64').length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  }
  if ((source.NIC_HASH_KEY ?? '').length < 32) throw new Error('NIC_HASH_KEY must be at least 32 characters');
  return {
    port: Number(source.PORT ?? 4000),
    jwtSecret,
    jwtExpiresIn: source.JWT_EXPIRES_IN ?? '30m',
    webOrigin: source.WEB_ORIGIN ?? 'http://localhost:3000',
    // Secure by default in production; an explicit COOKIE_SECURE=false is needed to turn it off.
    cookieSecure: source.COOKIE_SECURE ? source.COOKIE_SECURE === 'true' : source.NODE_ENV === 'production',
  };
}
