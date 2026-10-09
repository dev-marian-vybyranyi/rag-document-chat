ALTER TABLE "chunks" ADD COLUMN "code_search_vector" "tsvector" GENERATED ALWAYS AS (CASE WHEN path IS NULL THEN NULL ELSE to_tsvector('simple', coalesce(path, '') || ' ' || coalesce(symbol, '') || ' ' || content || ' ' || regexp_replace(
  regexp_replace(
    regexp_replace(coalesce(path, '') || ' ' || coalesce(symbol, '') || ' ' || content, '([A-Z]+)([A-Z][a-z])', '\1 \2', 'g'),
    '([a-z0-9])([A-Z])', '\1 \2', 'g'),
  '[^A-Za-z0-9]+', ' ', 'g')) END) STORED;--> statement-breakpoint
CREATE INDEX "chunks_code_search_vector_idx" ON "chunks" USING gin ("code_search_vector");