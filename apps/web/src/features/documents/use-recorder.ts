import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const FORMATS = [
  { mimeType: 'audio/webm;codecs=opus', type: 'audio/webm', extension: '.webm' },
  { mimeType: 'audio/webm', type: 'audio/webm', extension: '.webm' },
  { mimeType: 'audio/mp4', type: 'audio/mp4', extension: '.m4a' },
] as const;

export const CHUNK_MS = 1000;
export const STOP_MARGIN_BYTES = 512 * 1024;

export interface RecordingFormat {
  mimeType: string;
  type: string;
  extension: string;
}

export function recordingFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  return FORMATS.find((format) => MediaRecorder.isTypeSupported(format.mimeType)) ?? null;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'recorded';

const DENIED = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError']);
const MISSING = new Set(['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError']);

export function microphoneProblem(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (DENIED.has(name)) {
    return 'The microphone is blocked. Allow it for this site in the browser, or upload a file.';
  }
  if (MISSING.has(name)) return 'No microphone was found. Connect one, or upload a file.';
  return 'The microphone could not be started. Try again, or upload a file.';
}

export function useRecorder(maxBytes: number) {
  const format = useMemo(() => recordingFormat(), []);
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const keep = useRef(true);

  const release = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  const discard = useCallback(() => {
    keep.current = false;
    const active = recorder.current;
    if (active && active.state !== 'inactive') active.stop();
    else release();
    setFile(null);
    setSeconds(0);
    setProblem(null);
    setLimitReached(false);
    setState('idle');
  }, [release]);

  useEffect(
    () => () => {
      const active = recorder.current;
      if (active && active.state !== 'inactive') active.stop();
      release();
    },
    [release],
  );

  const stop = useCallback(() => {
    const active = recorder.current;
    if (active && active.state !== 'inactive') active.stop();
  }, []);

  const start = useCallback(async () => {
    if (!format || state === 'starting' || state === 'recording') return;
    setProblem(null);
    setLimitReached(false);
    setFile(null);
    setSeconds(0);
    setState('starting');

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setProblem(microphoneProblem(error));
      setState('idle');
      return;
    }

    const chunks: Blob[] = [];
    let bytes = 0;
    let started: MediaRecorder;
    try {
      started = new MediaRecorder(media, { mimeType: format.mimeType });
    } catch (error) {
      media.getTracks().forEach((track) => track.stop());
      setProblem(microphoneProblem(error));
      setState('idle');
      return;
    }

    keep.current = true;
    stream.current = media;
    recorder.current = started;

    started.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (bytes >= maxBytes - STOP_MARGIN_BYTES && started.state !== 'inactive') {
        setLimitReached(true);
        started.stop();
      }
    };
    started.onstop = () => {
      const wanted = keep.current;
      release();
      if (!wanted) return;
      if (chunks.length === 0) {
        setProblem('Nothing was recorded. Try again, or upload a file.');
        setState('idle');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      setFile(new File(chunks, `recording-${stamp}${format.extension}`, { type: format.type }));
      setState('recorded');
    };
    started.onerror = () => {
      setProblem('The recording failed. Try again, or upload a file.');
      if (started.state !== 'inactive') started.stop();
    };

    started.start(CHUNK_MS);
    timer.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    setState('recording');
  }, [format, maxBytes, release, state]);

  return {
    supported: format !== null,
    state,
    seconds,
    file,
    problem,
    limitReached,
    start,
    stop,
    discard,
  };
}
