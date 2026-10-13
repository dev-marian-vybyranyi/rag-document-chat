import type { DocumentItem } from './api';

export const MAX_MEETING_QUESTIONS = 4;
const MAX_QUESTION_LENGTH = 140;
const MAX_TITLE_IN_QUESTION = 50;

function shortTitle(title: string): string {
  return title.length <= MAX_TITLE_IN_QUESTION
    ? title
    : `${title.slice(0, MAX_TITLE_IN_QUESTION - 1).trimEnd()}…`;
}

export function meetingQuestions(document: DocumentItem): string[] {
  const title = shortTitle(document.filename);
  const { notes, participants } = document;
  const owner = notes?.actionItems.find((item) => item.owner !== null)?.owner ?? null;
  const topic = notes?.topics[0];
  const speaker = participants?.[1] ?? participants?.[0];

  const candidates = [
    notes && notes.decisions.length > 0 ? `What decisions were made in ${title}?` : null,
    notes && notes.actionItems.length > 0 ? `What are the action items from ${title}?` : null,
    owner ? `What is ${owner} responsible for in ${title}?` : null,
    topic && speaker ? `What did ${speaker} say about ${topic}?` : null,
    notes && notes.openQuestions.length > 0 ? `What was left open in ${title}?` : null,
    `What was discussed in ${title}?`,
    participants?.[0] ? `What did ${participants[0]} say in ${title}?` : null,
  ];

  const usable = candidates.filter(
    (question): question is string => question !== null && question.length <= MAX_QUESTION_LENGTH,
  );
  return [...new Set(usable)].slice(0, MAX_MEETING_QUESTIONS);
}

export function suggestionsOf(document: DocumentItem): string[] {
  return document.kind === 'transcript' ? meetingQuestions(document) : document.suggestions;
}
