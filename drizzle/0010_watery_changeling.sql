ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_up_to_message_id" integer;--> statement-breakpoint
ALTER TABLE "sleep_cycle_settings" ADD COLUMN "report_channel_id" text;