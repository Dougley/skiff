ALTER TABLE "message_embeddings" DROP CONSTRAINT "message_embeddings_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "message_embeddings" DROP CONSTRAINT "message_embeddings_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "message_embeddings" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_embeddings" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_embeddings_channel" ON "message_embeddings" USING btree ("channel_id");--> statement-breakpoint
UPDATE "message_embeddings" SET "channel_id" = c."channel_id" FROM "conversations" c WHERE "message_embeddings"."conversation_id" = c."id";