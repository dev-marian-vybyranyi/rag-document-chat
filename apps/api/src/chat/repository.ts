import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chats, documents, messages } from '../db/schema.js';
import type { MessageRetrieval, MessageSource } from './types.js';

export type ChatRecord = typeof chats.$inferSelect;
export type MessageRecord = typeof messages.$inferSelect;

export const DEFAULT_CHAT_TITLE = 'New chat';

export interface NewMessage {
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: MessageSource[];
  retrieval?: MessageRetrieval;
}

export function createChatRepository(db: Database) {
  return {
    async create(
      userId: string,
      title: string = DEFAULT_CHAT_TITLE,
      sourceIds: string[] | null = null,
    ): Promise<ChatRecord> {
      const [chat] = await db.insert(chats).values({ userId, title, sourceIds }).returning();
      return chat!;
    },

    async ownedSourceIds(userId: string, ids: string[]): Promise<string[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.userId, userId), inArray(documents.id, ids)));
      return rows.map((row) => row.id);
    },

    async setScope(
      id: string,
      userId: string,
      sourceIds: string[] | null,
    ): Promise<ChatRecord | undefined> {
      const [chat] = await db
        .update(chats)
        .set({ sourceIds })
        .where(and(eq(chats.id, id), eq(chats.userId, userId)))
        .returning();
      return chat;
    },

    async listByUser(userId: string): Promise<ChatRecord[]> {
      return db
        .select()
        .from(chats)
        .where(eq(chats.userId, userId))
        .orderBy(desc(chats.updatedAt), desc(chats.id));
    },

    async countByUser(userId: string): Promise<number> {
      const [row] = await db.select({ total: count() }).from(chats).where(eq(chats.userId, userId));
      return row?.total ?? 0;
    },

    async findForUser(id: string, userId: string): Promise<ChatRecord | undefined> {
      const [chat] = await db
        .select()
        .from(chats)
        .where(and(eq(chats.id, id), eq(chats.userId, userId)));
      return chat;
    },

    async rename(id: string, userId: string, title: string): Promise<ChatRecord | undefined> {
      const [chat] = await db
        .update(chats)
        .set({ title })
        .where(and(eq(chats.id, id), eq(chats.userId, userId)))
        .returning();
      return chat;
    },

    async deleteForUser(id: string, userId: string): Promise<boolean> {
      const deleted = await db
        .delete(chats)
        .where(and(eq(chats.id, id), eq(chats.userId, userId)))
        .returning({ id: chats.id });
      return deleted.length > 0;
    },

    async messagesOf(chatId: string): Promise<MessageRecord[]> {
      return db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.seq));
    },

    async addMessage(input: NewMessage): Promise<MessageRecord> {
      return db.transaction(async (tx) => {
        const [message] = await tx
          .insert(messages)
          .values({
            chatId: input.chatId,
            role: input.role,
            content: input.content,
            sources: input.sources,
            retrieval: input.retrieval,
          })
          .returning();
        await tx
          .update(chats)
          .set({ updatedAt: sql`now()` })
          .where(eq(chats.id, input.chatId));
        return message!;
      });
    },
  };
}

export type ChatRepository = ReturnType<typeof createChatRepository>;
