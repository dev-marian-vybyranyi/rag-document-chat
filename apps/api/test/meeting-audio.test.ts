import { describe, expect, it } from 'vitest';
import { checkAudio } from '../src/meetings/audio.js';
import { defaultTranscriptLimits, transcriptLimitProblem } from '../src/meetings/limits.js';
import type { ParsedTranscript } from '../src/meetings/transcript.js';
import { audioSamples } from './helpers/audio.js';

describe('checkAudio', () => {
  it.each([
    ['talk.mp3', audioSamples.mp3(), 'audio/mpeg'],
    ['talk.MP3', audioSamples.mp3WithoutTag(), 'audio/mpeg'],
    ['talk.wav', audioSamples.wav(), 'audio/wav'],
    ['talk.m4a', audioSamples.m4a(), 'audio/mp4'],
    ['talk.webm', audioSamples.webm(), 'audio/webm'],
  ])('accepts %s with the bytes of that kind of file', (name, bytes, mediaType) => {
    expect(checkAudio(name, bytes)).toEqual({ ok: true, mediaType });
  });

  it.each(['talk.ogg', 'talk.txt', 'talk', 'talk.mp3.exe', 'talk.mp4'])(
    'refuses the name %s',
    (name) => {
      expect(checkAudio(name, audioSamples.mp3())).toEqual({
        ok: false,
        problem: 'Only .mp3, .wav, .m4a and .webm recordings are supported',
      });
    },
  );

  it.each([
    ['talk.mp3', audioSamples.wav()],
    ['talk.wav', audioSamples.mp3()],
    ['talk.m4a', audioSamples.webm()],
    ['talk.webm', audioSamples.m4a()],
  ])('refuses %s when the bytes are another kind of file', (name, bytes) => {
    const extension = name.split('.')[1];
    expect(checkAudio(name, bytes)).toEqual({
      ok: false,
      problem: `The file is not a valid .${extension} recording`,
    });
  });

  it('refuses an empty file and a text file with an audio name', () => {
    expect(checkAudio('a.mp3', Buffer.alloc(0)).ok).toBe(false);
    expect(checkAudio('a.mp3', Buffer.from('[00:00:01] Alice: hello'))).toMatchObject({
      ok: false,
    });
    expect(checkAudio('a.wav', Buffer.from('RIFF'))).toMatchObject({ ok: false });
  });

  it('does not take a lone 0xff byte for an mp3', () => {
    expect(checkAudio('a.mp3', Buffer.from([0xff]))).toMatchObject({ ok: false });
    expect(checkAudio('a.mp3', Buffer.from([0xff, 0x10, 0, 0]))).toMatchObject({ ok: false });
  });
});

describe('transcriptLimitProblem', () => {
  const limits = { ...defaultTranscriptLimits, maxTurns: 3, maxSpeakers: 2, maxCharacters: 20 };
  const transcript = (turns: number, speakers: number, text = 'hi'): ParsedTranscript => ({
    turns: Array.from({ length: turns }, (_, i) => ({
      speaker: `S${i % speakers}`,
      startMs: i * 1000,
      text,
    })),
    participants: Array.from({ length: speakers }, (_, i) => `S${i}`),
    durationMs: 0,
    outOfOrderTurns: 0,
  });

  it('accepts a transcript exactly at the limits', () => {
    expect(transcriptLimitProblem(transcript(3, 2, 'x'.repeat(6)), limits)).toBeNull();
  });

  it('names the limit that was passed', () => {
    expect(transcriptLimitProblem(transcript(4, 2), limits)).toBe(
      'The transcript has too many turns (limit 3)',
    );
    expect(transcriptLimitProblem(transcript(3, 3), limits)).toBe(
      'The transcript has too many speakers (limit 2)',
    );
    expect(transcriptLimitProblem(transcript(3, 2, 'x'.repeat(7)), limits)).toBe(
      'The transcript is too long (limit 20 characters)',
    );
  });
});
