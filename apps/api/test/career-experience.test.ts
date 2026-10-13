import { describe, expect, it } from 'vitest';
import {
  experienceMonths,
  totalExperienceYears,
  type DatedRole,
} from '../src/career/experience.js';

const NOW = new Date(Date.UTC(2026, 9, 13));

const role = (start: string | null, end: string | null): DatedRole => ({ start, end });
const months = (roles: DatedRole[], now = NOW) => experienceMonths(roles, now);

describe('months of experience', () => {
  describe('one role', () => {
    it('counts both the first and the last month', () => {
      expect(months([role('2020-01', '2020-12')])).toBe(12);
      expect(months([role('2021-03', '2024-06')])).toBe(40);
    });

    it('counts a single month as one month', () => {
      expect(months([role('2022-05', '2022-05')])).toBe(1);
    });

    it('runs an open role up to the current month, counting it', () => {
      expect(months([role('2026-01', null)])).toBe(10);
      expect(months([role('2025-10', null)], NOW)).toBe(13);
    });

    it('depends on the month of the clock, not on the day', () => {
      expect(months([role('2026-01', null)], new Date(Date.UTC(2026, 9, 1)))).toBe(10);
      expect(months([role('2026-01', null)], new Date(Date.UTC(2026, 9, 31, 23, 59)))).toBe(10);
      expect(months([role('2026-01', null)], new Date(Date.UTC(2026, 10, 1)))).toBe(11);
    });

    it('works across the turn of a year', () => {
      expect(months([role('2019-11', '2020-02')])).toBe(4);
      expect(months([role('2025-12', null)], new Date(Date.UTC(2026, 0, 5)))).toBe(2);
    });
  });

  describe('several roles', () => {
    it('adds roles with a gap between them, without the gap', () => {
      expect(months([role('2018-01', '2019-12'), role('2021-01', '2021-12')])).toBe(36);
    });

    it('adds roles that follow each other directly', () => {
      expect(months([role('2018-01', '2018-06'), role('2018-07', '2018-12')])).toBe(12);
    });

    it('counts an overlap once', () => {
      expect(months([role('2018-01', '2019-12'), role('2019-07', '2020-06')])).toBe(30);
    });

    it('counts a role inside another one once', () => {
      expect(months([role('2018-01', '2022-12'), role('2019-03', '2019-09')])).toBe(60);
    });

    it('counts the same role twice as once', () => {
      expect(months([role('2020-01', '2020-12'), role('2020-01', '2020-12')])).toBe(12);
    });

    it('does not depend on the order of the roles', () => {
      const roles = [
        role('2021-01', '2021-12'),
        role('2015-06', '2017-05'),
        role('2016-01', '2018-12'),
        role('2024-02', null),
      ];

      expect(months([...roles].reverse())).toBe(months(roles));
      expect(months([roles[2]!, roles[0]!, roles[3]!, roles[1]!])).toBe(months(roles));
    });

    it('counts a job that is still open together with an earlier one that ran into it', () => {
      expect(months([role('2024-01', '2025-06'), role('2025-01', null)])).toBe(34);
    });
  });

  describe('dates that cannot be right', () => {
    it.each([
      ['no start', role(null, '2020-12')],
      ['no start and no end', role(null, null)],
      ['a start in words', role('March 2020', '2021-01')],
      ['a start with the year only', role('2020', '2021-01')],
      ['an end in words', role('2020-01', 'present')],
      ['a month that does not exist', role('2020-13', '2021-01')],
      ['month zero', role('2020-00', '2021-01')],
      ['a one-digit month', role('2020-1', '2021-01')],
      ['a full date', role('2020-01-15', '2021-01')],
      ['text around the date', role(' 2020-01', '2021-01 ')],
      ['a start that is not a date at all', role('x2020-01y', '2021-01')],
      ['a year before 1950', role('1949-01', '1951-01')],
      ['an end before the start', role('2022-06', '2021-01')],
      ['a start in the future', role('2026-11', null)],
      ['a start far in the future', role('2031-01', '2032-01')],
    ])('ignores a role with %s', (_label, bad) => {
      expect(months([bad])).toBe(0);
      expect(months([bad, role('2020-01', '2020-12')])).toBe(12);
    });

    it('stops a role that ends in the future at the current month', () => {
      expect(months([role('2026-06', '2027-12')])).toBe(5);
    });

    it('ignores an end before the start even when the start is the current month', () => {
      expect(months([role('2026-10', '2026-09')])).toBe(0);
    });
  });

  it('is zero for no roles', () => {
    expect(months([])).toBe(0);
  });

  it('agrees with counting the months one by one', () => {
    let seed = 12345;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % limit;
    };
    const label = (index: number) =>
      `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    const base = 2010 * 12;
    const current = 2026 * 12 + 9;

    for (let round = 0; round < 200; round++) {
      const roles: DatedRole[] = [];
      const covered = new Set<number>();
      for (let i = 0, count = 1 + next(6); i < count; i++) {
        const start = base + next(190);
        const length = next(40);
        const open = next(8) === 0;
        roles.push(role(label(start), open ? null : label(start + length)));
        const end = open ? current : Math.min(start + length, current);
        for (let m = start; m <= end; m++) covered.add(m);
      }

      expect(months(roles)).toBe(covered.size);
    }
  });
});

describe('years of experience', () => {
  it('turns months into years with one decimal', () => {
    expect(totalExperienceYears([role('2020-01', '2020-12')], NOW)).toBe(1);
    expect(totalExperienceYears([role('2018-01', '2024-05')], NOW)).toBe(6.4);
    expect(totalExperienceYears([role('2020-01', '2020-06')], NOW)).toBe(0.5);
  });

  it('rounds to the nearest tenth', () => {
    expect(totalExperienceYears([role('2020-01', '2020-04')], NOW)).toBe(0.3);
    expect(totalExperienceYears([role('2020-01', '2020-05')], NOW)).toBe(0.4);
    expect(totalExperienceYears([role('2020-01', '2025-04')], NOW)).toBe(5.3);
  });

  it('counts the work history of a typical resume without double counting', () => {
    const roles = [
      role('2021-03', '2024-06'),
      role('2018-01', '2021-02'),
      role('2020-06', '2021-01'),
      role('2024-09', null),
    ];

    expect(months(roles)).toBe(38 + 40 + 26);
    expect(totalExperienceYears(roles, NOW)).toBe(8.7);
  });

  it('has no answer when no role has usable dates', () => {
    expect(totalExperienceYears([], NOW)).toBeNull();
    expect(totalExperienceYears([role(null, null), role('soon', 'later')], NOW)).toBeNull();
  });

  it('uses the real clock when none is given', () => {
    const start = `${new Date().getUTCFullYear()}-01`;

    expect(totalExperienceYears([role(start, null)])).toBeGreaterThan(0);
  });
});
