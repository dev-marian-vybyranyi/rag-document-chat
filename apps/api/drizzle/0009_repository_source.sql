ALTER TABLE "documents" ADD COLUMN "repo_url" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "repo_ref" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "commit_sha" text;