CREATE SCHEMA "admin";
--> statement-breakpoint
CREATE TABLE "admin"."job_run" (
	"name" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"kind" text DEFAULT 'stooq_import' NOT NULL,
	"param" text,
	"status" text NOT NULL,
	"details" jsonb,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latest_date" date,
	"rows_deleted" integer
);
