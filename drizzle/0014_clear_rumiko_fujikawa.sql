CREATE TABLE "storyline_event_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_event_id" integer NOT NULL,
	"to_event_id" integer NOT NULL,
	"relation" text NOT NULL,
	"rationale" text,
	"created_by_user_id" text,
	"source_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "idx_storyline_event_links_unique" UNIQUE("from_event_id","to_event_id","relation")
);
--> statement-breakpoint
CREATE TABLE "storyline_event_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "idx_storyline_event_sources_unique" UNIQUE("event_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "storyline_event_links" ADD CONSTRAINT "storyline_event_links_from_event_id_storyline_events_id_fk" FOREIGN KEY ("from_event_id") REFERENCES "public"."storyline_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyline_event_links" ADD CONSTRAINT "storyline_event_links_to_event_id_storyline_events_id_fk" FOREIGN KEY ("to_event_id") REFERENCES "public"."storyline_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyline_event_links" ADD CONSTRAINT "storyline_event_links_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyline_event_sources" ADD CONSTRAINT "storyline_event_sources_event_id_storyline_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."storyline_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyline_event_sources" ADD CONSTRAINT "storyline_event_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storyline_event_links_from" ON "storyline_event_links" USING btree ("from_event_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_event_links_to" ON "storyline_event_links" USING btree ("to_event_id");--> statement-breakpoint
CREATE INDEX "idx_storyline_event_sources_event" ON "storyline_event_sources" USING btree ("event_id");