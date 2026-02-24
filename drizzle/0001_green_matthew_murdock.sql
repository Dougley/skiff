CREATE TABLE "scheduled_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text,
	"channel_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"cron_expression" text,
	"next_run_at" timestamp NOT NULL,
	"last_run_at" timestamp,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_next_run" ON "scheduled_tasks" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_channel" ON "scheduled_tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_enabled" ON "scheduled_tasks" USING btree ("enabled");