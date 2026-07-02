ALTER TABLE "sleep_cycle_settings" DROP CONSTRAINT "sleep_cycle_settings_pkey";--> statement-breakpoint
ALTER TABLE "sleep_cycle_settings" ALTER COLUMN "guild_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona_addenda" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "sleep_cycle_runs" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "sleep_cycle_settings" ADD COLUMN "channel_id" text;--> statement-breakpoint
CREATE INDEX "idx_persona_addenda_channel" ON "persona_addenda" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sleep_settings_guild" ON "sleep_cycle_settings" USING btree ("guild_id") WHERE guild_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sleep_settings_channel" ON "sleep_cycle_settings" USING btree ("channel_id") WHERE channel_id is not null;