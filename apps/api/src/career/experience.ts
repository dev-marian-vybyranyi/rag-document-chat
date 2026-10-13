export interface DatedRole {
  start: string | null;
  end: string | null;
}

const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const FIRST_YEAR = 1950;
const MONTHS_PER_YEAR = 12;

function monthIndex(value: string): number | null {
  const match = YEAR_MONTH.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < FIRST_YEAR) return null;
  return year * MONTHS_PER_YEAR + Number(match[2]) - 1;
}

function currentMonthIndex(now: Date): number {
  return now.getUTCFullYear() * MONTHS_PER_YEAR + now.getUTCMonth();
}

function intervalOf(role: DatedRole, current: number): [number, number] | null {
  if (role.start === null) return null;
  const start = monthIndex(role.start);
  const end = role.end === null ? current : monthIndex(role.end);
  if (start === null || end === null) return null;

  const last = Math.min(end, current);
  return last < start ? null : [start, last];
}

export function experienceMonths(roles: DatedRole[], now: Date = new Date()): number {
  const current = currentMonthIndex(now);
  const intervals = roles
    .flatMap((role) => {
      const interval = intervalOf(role, current);
      return interval === null ? [] : [interval];
    })
    .sort((a, b) => a[0] - b[0]);

  let months = 0;
  let coveredUpTo = -Infinity;
  for (const [start, end] of intervals) {
    const from = Math.max(start, coveredUpTo + 1);
    if (end >= from) months += end - from + 1;
    coveredUpTo = Math.max(coveredUpTo, end);
  }
  return months;
}

export function totalExperienceYears(roles: DatedRole[], now: Date = new Date()): number | null {
  const months = experienceMonths(roles, now);
  return months === 0 ? null : Math.round((months / MONTHS_PER_YEAR) * 10) / 10;
}
