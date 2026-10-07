CREATE TYPE "public"."trace_outcome" AS ENUM('answered', 'declined', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "rag_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid,
	"outcome" "trace_outcome" NOT NULL,
	"question" text NOT NULL,
	"rewritten_query" text,
	"retrieval_mode" text,
	"best_score" double precision,
	"threshold" double precision,
	"retrieved" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rewrite_ms" integer,
	"retrieval_ms" integer,
	"generation_ms" integer,
	"total_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"model" text,
	"error_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_traces" ADD CONSTRAINT "rag_traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_traces_user_id_created_at_idx" ON "rag_traces" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "rag_traces_chat_id_idx" ON "rag_traces" USING btree ("chat_id");