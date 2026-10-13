import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { microphoneProblem, recordingFormat, useRecorder } from './use-recorder';

const supports = (...types: string[]) => {
  vi.stubGlobal('MediaRecorder', { isTypeSupported: (type: string) => types.includes(type) });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn() },
    configurable: true,
  });
};

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('recordingFormat', () => {
  it('is nothing where there is no recorder or no microphone access', () => {
    expect(recordingFormat()).toBeNull();
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    expect(recordingFormat()).toBeNull();
  });

  it('prefers webm with opus, then webm, then mp4 and names the extension', () => {
    supports('audio/webm;codecs=opus', 'audio/webm', 'audio/mp4');
    expect(recordingFormat()).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      type: 'audio/webm',
      extension: '.webm',
    });

    supports('audio/webm', 'audio/mp4');
    expect(recordingFormat()?.mimeType).toBe('audio/webm');

    supports('audio/mp4');
    expect(recordingFormat()).toEqual({
      mimeType: 'audio/mp4',
      type: 'audio/mp4',
      extension: '.m4a',
    });
  });

  it('is nothing when the browser records none of the formats the server takes', () => {
    supports('audio/ogg');
    expect(recordingFormat()).toBeNull();
  });
});

describe('microphoneProblem', () => {
  it.each([
    ['NotAllowedError', /blocked/],
    ['SecurityError', /blocked/],
    ['NotFoundError', /No microphone/],
    ['OverconstrainedError', /No microphone/],
    ['AbortError', /could not be started/],
  ])('explains %s', (name, message) => {
    expect(microphoneProblem(new DOMException('x', name))).toMatch(message);
  });

  it('has an answer for anything else', () => {
    expect(microphoneProblem('boom')).toMatch(/could not be started/);
    expect(microphoneProblem(new Error('boom'))).toMatch(/could not be started/);
  });
});

describe('useRecorder', () => {
  class Recorder {
    static current: Recorder;
    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      Recorder.current = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      queueMicrotask(() => this.onstop?.());
    }
  }

  function microphone() {
    const stop = vi.fn();
    vi.stubGlobal('MediaRecorder', Object.assign(Recorder, { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
      configurable: true,
    });
    return stop;
  }

  it('keeps nothing when the recording is discarded while it runs', async () => {
    const stopTrack = microphone();
    const { result } = renderHook(() => useRecorder(1_000_000));

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      Recorder.current.ondataavailable?.({ data: new Blob(['audio']) });
      result.current.discard();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.file).toBeNull();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('lets go of the microphone when it is unmounted during a recording', async () => {
    const stopTrack = microphone();
    const { result, unmount } = renderHook(() => useRecorder(1_000_000));
    await act(async () => {
      await result.current.start();
    });

    unmount();

    expect(stopTrack).toHaveBeenCalled();
    expect(Recorder.current.state).toBe('inactive');
  });
});
