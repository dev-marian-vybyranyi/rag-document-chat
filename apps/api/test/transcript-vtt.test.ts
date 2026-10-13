import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../src/meetings/parser.js';
import { TranscriptParseError } from '../src/meetings/transcript.js';

const lines = (...rows: string[]) => rows.join('\n');

function failure(text: string): TranscriptParseError {
  try {
    parseTranscript(text);
  } catch (error) {
    if (error instanceof TranscriptParseError) return error;
    throw error;
  }
  throw new Error('expected the transcript to be refused');
}

describe('WebVTT transcripts', () => {
  it('reads voice tags, including a class on the tag', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<v Alice Smith>Hello there.</v>',
        '',
        '00:00:05.000 --> 00:00:07.000',
        '<v.loud Bob>Hi.</v>',
      ),
    );

    expect(parsed.turns).toEqual([
      { speaker: 'Alice Smith', startMs: 1000, text: 'Hello there.' },
      { speaker: 'Bob', startMs: 5000, text: 'Hi.' },
    ]);
    expect(parsed.participants).toEqual(['Alice Smith', 'Bob']);
  });

  it('reads "Name: text" at the start of a cue', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:01.000 --> 00:04.000',
        'Alice: Hello there.',
        '',
        '00:05.000 --> 00:07.000',
        'Bob: Hi.',
      ),
    );

    expect(parsed.turns.map((t) => [t.speaker, t.startMs, t.text])).toEqual([
      ['Alice', 1000, 'Hello there.'],
      ['Bob', 5000, 'Hi.'],
    ]);
  });

  it('skips the header text, notes, styles, regions, cue numbers and cue settings', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT - Weekly sync',
        'Kind: captions',
        '',
        'NOTE this is a comment',
        'spanning two lines',
        '',
        'STYLE',
        '::cue { color: red }',
        '',
        '1',
        '00:00:01.000 --> 00:00:04.000 align:start position:0%',
        '<v Alice>Hello.</v>',
        '',
        'second',
        '00:00:05.000 --> 00:00:07.000',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(parsed.turns.map((t) => t.speaker)).toEqual(['Alice', 'Bob']);
  });

  it('removes other markup and decodes entities', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<v Alice><i>Tom &amp; Jerry</i> &lt;3<00:00:02.000><c> now</c></v>',
        '',
        '00:00:05.000 --> 00:00:07.000',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(parsed.turns[0]!.text).toBe('Tom & Jerry <3 now');
  });

  it('joins a cue that spans several lines', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<v Alice>Hello',
        'there.</v>',
        '',
        '00:00:05.000 --> 00:00:07.000',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(parsed.turns[0]!.text).toBe('Hello there.');
  });

  it('lets a cue without a speaker continue the previous speaker as a turn of its own', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<v Alice>Hello there.</v>',
        '',
        '00:00:05.000 --> 00:00:07.000',
        'And one more thing.',
        '',
        '00:00:08.000 --> 00:00:09.000',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(parsed.turns.map((t) => [t.speaker, t.startMs])).toEqual([
      ['Alice', 1000],
      ['Alice', 5000],
      ['Bob', 8000],
    ]);
  });

  it('skips a cue with no words', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.000',
        '<v Carol></v>',
        '',
        '00:00:03.000 --> 00:00:04.000',
        '<v Alice>Hello.</v>',
        '',
        '00:00:05.000 --> 00:00:06.000',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(parsed.participants).toEqual(['Alice', 'Bob']);
  });

  it('measures the length from the first cue to the end of the last', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:10.000 --> 00:00:14.000',
        '<v Alice>Hello.</v>',
        '',
        '00:01:00.000 --> 00:01:30.500',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(parsed.durationMs).toBe(80_500);
  });

  it('counts cues that go back in time', () => {
    const parsed = parseTranscript(
      lines(
        'WEBVTT',
        '',
        '00:00:10.000 --> 00:00:14.000',
        '<v Alice>One.</v>',
        '',
        '00:00:05.000 --> 00:00:08.000',
        '<v Bob>Two.</v>',
      ),
    );

    expect(parsed.outOfOrderTurns).toBe(1);
  });

  it('copes with Windows line endings', () => {
    const parsed = parseTranscript(
      'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:04.000\r\n<v Alice>Hello.</v>\r\n\r\n00:00:05.000 --> 00:00:07.000\r\n<v Bob>Hi.</v>\r\n',
    );

    expect(parsed.turns).toHaveLength(2);
  });

  it('refuses a first cue without a speaker, and says where it is', () => {
    const error = failure(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        'Hello there.',
        '',
        '00:00:05.000 --> 00:00:07.000',
        '<v Bob>Hi.</v>',
      ),
    );

    expect(error.line).toBe(3);
    expect(error.message).toMatch(/the cue has no speaker/);
  });

  it('refuses a block that is not a cue, and says where it is', () => {
    const error = failure(
      lines(
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:04.000',
        '<v Alice>Hello.</v>',
        '',
        'something else',
        'entirely',
      ),
    );

    expect(error.line).toBe(6);
    expect(error.message).toMatch(/expected a cue with a time range/);
  });

  it('refuses a cue with an impossible time', () => {
    const error = failure(
      lines('WEBVTT', '', '00:00:61.000 --> 00:00:64.000', '<v Alice>Hello.</v>'),
    );

    expect(error.line).toBe(3);
    expect(error.message).toMatch(/not a valid timestamp/);
  });

  it('refuses a file with fewer than two spoken cues', () => {
    expect(
      failure(lines('WEBVTT', '', '00:00:01.000 --> 00:00:04.000', '<v Alice>Hello.</v>')).message,
    ).toMatch(/fewer than two spoken cues/);
    expect(failure('WEBVTT\n').message).toMatch(/fewer than two spoken cues/);
  });

  it('is only chosen when the file starts with WEBVTT', () => {
    const error = failure(
      lines('Intro', 'WEBVTT', '', '00:00:01.000 --> 00:00:04.000', '<v Alice>Hello.</v>'),
    );

    expect(error.message).toMatch(/no line starts with a speaker and a time/);
  });
});
