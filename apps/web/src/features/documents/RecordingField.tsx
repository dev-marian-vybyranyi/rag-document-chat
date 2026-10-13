import { MicIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatClock } from './meeting-status';
import { useRecorder } from './use-recorder';
import {
  MAX_RECORDING_BYTES,
  RECORDING_LIMIT_LABEL,
  formatBytes,
  validateRecording,
} from './validation';

interface RecordingFieldProps {
  disabled: boolean;
  onChange: (file: File | null, problem: string | null) => void;
}

export function RecordingField({ disabled, onChange }: RecordingFieldProps) {
  const recorder = useRecorder(MAX_RECORDING_BYTES);
  const [fileKey, setFileKey] = useState(0);
  const { file: recorded, problem: recorderProblem, state } = recorder;

  useEffect(() => {
    if (state === 'recorded' && recorded) {
      onChange(recorded, validateRecording(recorded));
    }
  }, [state, recorded, onChange]);

  function choose(file: File | undefined) {
    recorder.discard();
    if (!file) {
      onChange(null, null);
      return;
    }
    const invalid = validateRecording(file);
    onChange(invalid ? null : file, invalid);
  }

  function startRecording() {
    setFileKey((key) => key + 1);
    onChange(null, null);
    void recorder.start();
  }

  function discardRecording() {
    recorder.discard();
    onChange(null, null);
  }

  const busy = disabled || state === 'recording' || state === 'starting';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="meeting-recording">Recording file</Label>
        <Input
          key={fileKey}
          id="meeting-recording"
          type="file"
          accept=".mp3,.wav,.m4a,.webm,audio/mpeg,audio/wav,audio/mp4,audio/webm"
          disabled={busy}
          aria-describedby="meeting-recording-hint"
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <p id="meeting-recording-hint" className="text-xs text-muted-foreground">
          An .mp3, .wav, .m4a or .webm file, up to {RECORDING_LIMIT_LABEL}. It is turned into text
          and then thrown away. Speakers are labelled Speaker 1, Speaker 2 and so on, and the times
          are estimates.
        </p>
      </div>

      {recorder.supported ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Or record now</span>
          {state === 'recording' ? (
            <div className="flex items-center gap-3">
              <Button type="button" variant="destructive" onClick={recorder.stop}>
                <SquareIcon aria-hidden />
                Stop recording
              </Button>
              <span role="timer" aria-label="Recording time" className="font-mono text-sm">
                {formatClock(recorder.seconds * 1000)}
              </span>
            </div>
          ) : state === 'recorded' && recorded ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                Recorded {formatClock(recorder.seconds * 1000)} · {formatBytes(recorded.size)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={discardRecording}
              >
                <Trash2Icon aria-hidden />
                Discard
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={busy}
              onClick={startRecording}
            >
              <MicIcon aria-hidden />
              {state === 'starting' ? 'Starting…' : 'Record from the microphone'}
            </Button>
          )}
          {recorder.limitReached && (
            <p role="status" className="text-xs text-muted-foreground">
              The recording stopped at the size limit.
            </p>
          )}
          {recorderProblem && (
            <p role="alert" className="text-sm text-destructive">
              {recorderProblem}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This browser cannot record from the microphone, so upload a file.
        </p>
      )}
    </div>
  );
}
