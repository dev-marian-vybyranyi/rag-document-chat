import { AUDIO_MEDIA_TYPES } from './transcriber.js';

export const AUDIO_EXTENSION = /\.(mp3|wav|m4a|webm)$/i;

const startsWith = (bytes: Uint8Array, prefix: number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((value, i) => bytes[offset + i] === value);

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  mp3: (bytes) =>
    startsWith(bytes, [0x49, 0x44, 0x33]) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0),
  wav: (bytes) =>
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8),
  m4a: (bytes) => startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4),
  webm: (bytes) => startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
};

export type AudioCheck = { ok: true; mediaType: string } | { ok: false; problem: string };

export function checkAudio(filename: string, bytes: Uint8Array): AudioCheck {
  const extension = AUDIO_EXTENSION.exec(filename)?.[1]?.toLowerCase();
  if (!extension) {
    return { ok: false, problem: 'Only .mp3, .wav, .m4a and .webm recordings are supported' };
  }
  if (!SIGNATURES[extension]!(bytes)) {
    return { ok: false, problem: `The file is not a valid .${extension} recording` };
  }
  return { ok: true, mediaType: AUDIO_MEDIA_TYPES[extension]! };
}
