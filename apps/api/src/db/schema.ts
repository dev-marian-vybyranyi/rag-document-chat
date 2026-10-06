import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

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

export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    status: documentStatus().notNull().default('processing'),
    error: text(),
    pageCount: integer(),
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
