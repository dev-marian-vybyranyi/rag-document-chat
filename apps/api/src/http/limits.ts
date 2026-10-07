export interface UsageLimits {
  maxDocumentsPerUser: number;
  maxChatsPerUser: number;
  maxMessagesPerChat: number;
}

export const defaultUsageLimits: UsageLimits = {
  maxDocumentsPerUser: 20,
  maxChatsPerUser: 100,
  maxMessagesPerChat: 200,
};

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;
