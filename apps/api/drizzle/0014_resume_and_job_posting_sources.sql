ALTER TYPE "public"."document_kind" ADD VALUE 'resume';--> statement-breakpoint
ALTER TYPE "public"."document_kind" ADD VALUE 'job_posting';--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "section" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "profile" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "job_number" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "fit" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_job_number_unique" UNIQUE("user_id","job_number");