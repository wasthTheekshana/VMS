import { isSessionCurrent } from './session';

const now = 1_800_000_000; // fixed clock (epoch seconds)
const user = { tokenVersion: 3 };
const H = 3600;

describe('isSessionCurrent', () => {
  it('accepts a token with the current version and a recent sign-in', () => {
    expect(isSessionCurrent({ tv: 3, at: now - H }, user, 12, now)).toBe(true);
  });

  it('rejects an older token version (what logout, password change and admin reset produce)', () => {
    expect(isSessionCurrent({ tv: 2, at: now - H }, user, 12, now)).toBe(false);
  });

  it('rejects a token claiming a NEWER version than the user has (forged)', () => {
    expect(isSessionCurrent({ tv: 4, at: now - H }, user, 12, now)).toBe(false);
  });

  it('rejects a sign-in older than the absolute limit, however fresh the token itself is', () => {
    expect(isSessionCurrent({ tv: 3, at: now - 12 * H - 1 }, user, 12, now)).toBe(false);
    expect(isSessionCurrent({ tv: 3, at: now - 12 * H }, user, 12, now)).toBe(true); // exactly at the limit
  });

  it('rejects tokens that lack the new claims (issued before this change) or carry the wrong types', () => {
    expect(isSessionCurrent({}, user, 12, now)).toBe(false);
    expect(isSessionCurrent({ tv: 3 }, user, 12, now)).toBe(false);
    expect(isSessionCurrent({ at: now }, user, 12, now)).toBe(false);
    expect(isSessionCurrent({ tv: '3' as unknown as number, at: now }, user, 12, now)).toBe(false);
    expect(isSessionCurrent({ tv: 3, at: NaN }, user, 12, now)).toBe(false);
  });

  it('rejects a sign-in time in the future', () => {
    expect(isSessionCurrent({ tv: 3, at: now + H }, user, 12, now)).toBe(false);
  });

  it('honours a different limit', () => {
    expect(isSessionCurrent({ tv: 3, at: now - 2 * H }, user, 1, now)).toBe(false);
    expect(isSessionCurrent({ tv: 3, at: now - 2 * H }, user, 24, now)).toBe(true);
  });
});
