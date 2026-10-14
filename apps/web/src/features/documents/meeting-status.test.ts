import { describe, expect, it } from 'vitest';
import type { DocumentItem, MeetingNotes } from './api';
import {
  describeMeetingCounts,
  describeNotesCounts,
  formatClock,
  formatDuration,
  formatMeetingDate,
  notesToMarkdown,
  shownSpeakers,
} from './meeting-status';

function meeting(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'm1',
    kind: 'transcript',
    filename: 'Release sync',
    mimeType: 'text/plain',
    sizeBytes: 1200,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 12,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: '2026-10-01',
    participants: ['Alice', 'Bob', 'Carol'],
    durationMs: 3_900_000,
    notes: null,
    progress: null,
    jobNumber: null,
    profile: null,
    fit: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

const notes: MeetingNotes = {
  summary: 'The team planned the release.',
  topics: ['Release', 'Roadmap'],
  decisions: [{ text: 'Ship on Friday.', startMs: 120_000, evidence: 'we ship on Friday' }],
  actionItems: [
    { task: 'Update the changelog.', owner: 'Carol', due: 'today', startMs: 70_000, evidence: 'x' },
    { task: 'Book the room.', owner: null, due: null, startMs: 3_725_000, evidence: 'y' },
  ],
  openQuestions: ['Who pays for the launch?'],
};

describe('formatClock', () => {
  it.each([
    [0, '00:00:00'],
    [999, '00:00:00'],
    [70_000, '00:01:10'],
    [3_725_000, '01:02:05'],
    [100 * 3_600_000, '100:00:00'],
    [-5, '00:00:00'],
  ])('shows %i ms as %s', (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, 'under a minute'],
    [29_000, 'under a minute'],
    [31_000, '1 min'],
    [85_000, '1 min'],
    [45 * 60_000, '45 min'],
    [3_600_000, '1 h'],
    [3_900_000, '1 h 05 min'],
    [2 * 3_600_000 + 20 * 60_000, '2 h 20 min'],
  ])('shows %i ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatMeetingDate', () => {
  it('writes the day, short month and year, whatever the time zone of the reader', () => {
    expect(formatMeetingDate('2026-10-01')).toBe('1 Oct 2026');
    expect(formatMeetingDate('2026-12-31')).toBe('31 Dec 2026');
    expect(formatMeetingDate('2028-02-29')).toBe('29 Feb 2028');
  });

  it.each([null, '', 'yesterday', '2026-1-1', '2026-13-45T00:00:00Z', '2026-02-31', '2026-00-10'])(
    'has nothing for %j',
    (value) => {
      expect(formatMeetingDate(value)).toBeNull();
    },
  );
});

describe('describeMeetingCounts', () => {
  it('lists the date, the length, the speakers and the passages', () => {
    expect(describeMeetingCounts(meeting())).toBe(
      '1 Oct 2026 · 1 h 05 min · 3 speakers · 12 passages',
    );
  });

  it('leaves out what is not known and says one in the singular', () => {
    expect(
      describeMeetingCounts(
        meeting({ meetingHeldOn: null, durationMs: null, participants: ['Alice'], chunkCount: 1 }),
      ),
    ).toBe('1 speaker · 1 passage');
    expect(describeMeetingCounts(meeting({ participants: null }))).not.toContain('speaker');
  });
});

describe('describeNotesCounts', () => {
  it('counts decisions and action items', () => {
    expect(describeNotesCounts(notes)).toBe('1 decision · 2 action items');
    expect(describeNotesCounts({ ...notes, decisions: [], actionItems: [] })).toBe(
      '0 decisions · 0 action items',
    );
  });
});

describe('shownSpeakers', () => {
  it('shows the first eight and counts the rest', () => {
    const names = Array.from({ length: 11 }, (_, i) => `P${i}`);

    expect(shownSpeakers(names)).toEqual({ shown: names.slice(0, 8), more: 3 });
    expect(shownSpeakers(['A', 'B'])).toEqual({ shown: ['A', 'B'], more: 0 });
  });
});

describe('notesToMarkdown', () => {
  it('writes the notes as a short Markdown document', () => {
    expect(notesToMarkdown(meeting(), notes)).toBe(
      [
        '# Release sync (1 Oct 2026)',
        '',
        'The team planned the release.',
        '',
        'Topics: Release; Roadmap',
        '',
        '## Decisions',
        '',
        '- [00:02:00] Ship on Friday.',
        '',
        '## Action items',
        '',
        '- [ ] [00:01:10] Update the changelog. (Carol, due: today)',
        '- [ ] [01:02:05] Book the room. (no owner stated)',
        '',
        '## Open questions',
        '',
        '- Who pays for the launch?',
        '',
      ].join('\n'),
    );
  });

  it('leaves out the date and the sections that are empty', () => {
    const text = notesToMarkdown(meeting({ meetingHeldOn: null }), {
      ...notes,
      topics: [],
      decisions: [],
      openQuestions: [],
    });

    expect(text.startsWith('# Release sync\n')).toBe(true);
    expect(text).not.toContain('## Decisions');
    expect(text).not.toContain('Topics:');
    expect(text).not.toContain('## Open questions');
    expect(text).toContain('## Action items');
  });

  it('ends with one newline', () => {
    expect(notesToMarkdown(meeting(), notes).endsWith('?\n')).toBe(true);
  });
});
