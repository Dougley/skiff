CREATE TABLE "heartbeat_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text,
	"channel_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
ALTER TABLE "scheduled_tasks" RENAME COLUMN "message" TO "instruction";