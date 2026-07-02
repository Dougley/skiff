ALTER TABLE "topic_knowledge" ADD COLUMN "channel_id" text;--> statement-breakpoint
CREATE INDEX "idx_topic_knowledge_channel" ON "topic_knowledge" USING btree ("channel_id");--> statement-breakpoint
UPDATE "topic_knowledge" SET "channel_id" = c."channel_id" FROM "conversations" c WHERE "topic_knowledge"."guild_id" IS NULL AND "topic_knowledge"."source_conversation_id" = c."id";