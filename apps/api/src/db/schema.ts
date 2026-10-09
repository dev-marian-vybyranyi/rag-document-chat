import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { MessageRetrieval, MessageSource } from '../chat/types.js';
import type { TracedChunk, TraceOutcome } from '../observability/types.js';

export const EMBEDDING_DIMENSIONS = 768;

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

export const documentStatus = pgEnum('document_status', ['processing', 'ready', 'failed']);

export const documentKind = pgEnum('document_kind', ['document', 'repository']);

export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: documentKind().notNull().default('document'),
    filename: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    status: documentStatus().notNull().default('processing'),
    error: text(),
    pageCount: integer(),
    embeddingModel: text(),
    repoUrl: text(),
    repoRef: text(),
    commitSha: text(),
    fileCount: integer(),
    progressPhase: text(),
    progressDone: integer(),
    progressTotal: integer(),
    suggestions: jsonb().$type<string[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('documents_user_id_created_at_idx').on(table.userId, table.createdAt)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ordinal: integer().notNull(),
    page: integer(),
    path: text(),
    language: text(),
    startLine: integer(),
    endLine: integer(),
    symbol: text(),
    content: text().notNull(),
    tokenCount: integer().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    searchVector: tsvector()
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', content)`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('chunks_document_id_ordinal_unique').on(table.documentId, table.ordinal),
    index('chunks_user_id_idx').on(table.userId),
    index('chunks_embedding_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('chunks_search_vector_idx').using('gin', table.searchVector),
  ],
);

export const messageRole = pgEnum('message_role', ['user', 'assistant']);

export const chats = pgTable(
  'chats',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('chats_user_id_updated_at_idx').on(table.userId, table.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    chatId: uuid()
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    seq: bigint({ mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    role: messageRole().notNull(),
    content: text().notNull(),
    sources: jsonb().$type<MessageSource[]>(),
    retrieval: jsonb().$type<MessageRetrieval>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('messages_chat_id_seq_idx').on(table.chatId, table.seq)],
);

export const traceOutcome = pgEnum('trace_outcome', [
  'answered',
  'declined',
  'failed',
  'cancelled',
]);

export const ragTraces = pgTable(
  'rag_traces',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid()
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    outcome: traceOutcome().$type<TraceOutcome>().notNull(),
    question: text().notNull(),
    rewrittenQuery: text(),
    retrievalMode: text().$type<'hybrid' | 'keyword-only'>(),
    bestScore: doublePrecision(),
    threshold: doublePrecision(),
    retrieved: jsonb().$type<TracedChunk[]>().notNull().default([]),
    rewriteMs: integer(),
    retrievalMs: integer(),
    generationMs: integer(),
    totalMs: integer().notNull(),
    inputTokens: integer(),
    outputTokens: integer(),
    citationsKept: integer(),
    citationsRemoved: integer(),
    model: text(),
    errorKind: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rag_traces_user_id_created_at_idx').on(table.userId, table.createdAt),
    index('rag_traces_chat_id_idx').on(table.chatId),
  ],
);
