ALTER TABLE "documents" ADD COLUMN "embedding_model" text;--> statement-breakpoint
UPDATE "documents" SET "embedding_model" = 'gemini-embedding-001' WHERE "status" = 'ready';