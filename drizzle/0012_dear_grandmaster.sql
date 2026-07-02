CREATE TABLE "command_id_hints" (
	"command_name" text PRIMARY KEY NOT NULL,
	"ids" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
