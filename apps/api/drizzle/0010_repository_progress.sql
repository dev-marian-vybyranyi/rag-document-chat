ALTER TABLE "documents" ADD COLUMN "file_count" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "progress_phase" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "progress_done" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "progress_total" integer;