/** Minimal "30m" / "12h" / "7d" -> milliseconds. */
export function ms(v: string): number {
  const m = /^(\d+)([smhd])$/.exec(v);
  if (!m) throw new Error(`Invalid duration: ${v}`);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}
