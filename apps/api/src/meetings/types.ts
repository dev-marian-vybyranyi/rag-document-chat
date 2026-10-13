export interface MeetingDecision {
  text: string;
  startMs: number;
  evidence: string;
}

export interface MeetingActionItem {
  task: string;
  owner: string | null;
  due: string | null;
  startMs: number;
  evidence: string;
}

export interface MeetingNotes {
  summary: string;
  topics: string[];
  decisions: MeetingDecision[];
  actionItems: MeetingActionItem[];
  openQuestions: string[];
}

export interface MeetingLocation {
  startMs: number | null;
  endMs: number | null;
  speakers: string[];
}
