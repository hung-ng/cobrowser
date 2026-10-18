export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
  if (!match) throw new Error('Use a duration such as 30m or 2h.');
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ];
  const duration = Number(match[1]) * unit;
  if (!Number.isFinite(duration) || duration <= 0 || duration > Number.MAX_SAFE_INTEGER)
    throw new Error('Use a positive duration such as 30m or 2h.');
  return duration;
}
