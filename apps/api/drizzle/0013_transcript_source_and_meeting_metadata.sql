ALTER TYPE "public"."document_kind" ADD VALUE 'transcript';--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "start_ms" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "end_ms" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "speakers" text[];--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "meeting_held_on" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "participants" text[];--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "notes" jsonb;