CREATE TABLE "persona_addenda" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text,
	"target" text,
	"text" text NOT NULL,
	"reason" text,
	"source_run_id" integer,
	"confidence" integer DEFAULT 80 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"superseded_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sleep_cycle_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target_table" text,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"reverted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sleep_cycle_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"status" text DEFAULT 'running' NOT NULL,
	"phase_stats" jsonb,
	"token_cost" integer,
	"trigger_reason" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sleep_cycle_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"auto_author_skills" boolean DEFAULT false NOT NULL,
	"low_activity_minutes" integer DEFAULT 60 NOT NULL,
	"min_inactive_messages" integer DEFAULT 3 NOT NULL,
	"max_runs_per_day" integer DEFAULT 2 NOT NULL,
	"last_run_at" timestamp,
	"next_eligible_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_knowledge" ADD COLUMN "superseded_by" integer;--> statement-breakpoint
ALTER TABLE "persona_addenda" ADD CONSTRAINT "persona_addenda_source_run_id_sleep_cycle_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."sleep_cycle_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_cycle_changes" ADD CONSTRAINT "sleep_cycle_changes_run_id_sleep_cycle_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sleep_cycle_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_persona_addenda_guild" ON "persona_addenda" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_persona_addenda_active" ON "persona_addenda" USING btree ("active");--> statement-breakpoint
CREATE INDEX "idx_sleep_changes_run" ON "sleep_cycle_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_sleep_changes_kind" ON "sleep_cycle_changes" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_sleep_runs_guild" ON "sleep_cycle_runs" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_sleep_runs_started" ON "sleep_cycle_runs" USING btree ("started_at");