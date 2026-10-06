-- Vector similarity search for document chunks. Drizzle does not manage extensions,
-- so it lives in a hand-written migration that must run before any table uses `vector`.
CREATE EXTENSION IF NOT EXISTS vector;
