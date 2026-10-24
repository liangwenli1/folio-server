ALTER TABLE "profiles" ADD COLUMN "search_engine" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "restore_tabs" boolean DEFAULT true NOT NULL;