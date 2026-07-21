CREATE TABLE "storyline_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"storyline_id" integer NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'active' NOT NULL,
	"actor_user_id" text,
	"owner_user_id" text,
	"due_at" timestamp,
	"source_message_id" integer,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storylines" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"current_state" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"guild_id" text,
	"channel_id" text,
	"created_by_user_id" text,
	"owner_user_ids" text[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source_message_id" integer,
	"embedding" vector(1536),
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storyline_events" ADD CONSTRAINT "storyline_events_storyline_id_storylines_id_fk" FOREIGN KEY ("storyline_id") REFERENCES "public"."storylines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyline_events" ADD CONSTRAINT "storyline_events_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storylines" ADD CONSTRAINT "storylines_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storyline_events_storyline" ON "storyline_events" USING btree ("storyline_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_events_status" ON "storyline_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_storyline_events_due" ON "storyline_events" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "idx_storylines_guild" ON "storylines" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_storylines_channel" ON "storylines" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_storylines_status" ON "storylines" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_storylines_activity" ON "storylines" USING btree ("last_activity_at");