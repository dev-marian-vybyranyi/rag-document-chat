CREATE TYPE "public"."document_kind" AS ENUM('document', 'repository');--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "start_line" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "end_line" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "symbol" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" "document_kind" DEFAULT 'document' NOT NULL;