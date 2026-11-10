/**
 * Session rules shared by the HTTP guard, the refresh endpoint and the WebSocket handshake.
 *
 * A session token carries:
 *   sub  the user id
 *   tv   the user's `tokenVersion` when the token was issued
 *   at   when the user ACTUALLY signed in (epoch seconds). Refreshing keeps the original `at`, so activity
 *        can extend the idle window but never the absolute session lifetime.
 */
export interface SessionClaims {
  sub: string;
  tv: number;
  at: number;
  iat?: number;
  exp?: number;
}

/**
 * A token is usable only while it carries the user's CURRENT token version (logout, password change and admin
 * reset bump it, which kills every older token at once) and the original sign-in is younger than the absolute limit.
 */
export function isSessionCurrent(
  claims: Partial<SessionClaims>,
  user: { tokenVersion: number },
  maxHours: number,
  nowSec = Date.now() / 1000,
): boolean {
  if (!Number.isInteger(claims.tv) || claims.tv !== user.tokenVersion) return false;
  if (typeof claims.at !== 'number' || !Number.isFinite(claims.at)) return false;
  if (claims.at > nowSec + 60) return false; // a sign-in time in the future is forged
  return nowSec - claims.at <= maxHours * 3600;
}
