ALTER TABLE "user_facts" ADD COLUMN "channel_id" text;--> statement-breakpoint
CREATE INDEX "idx_user_facts_user_channel" ON "user_facts" USING btree ("user_id","channel_id");