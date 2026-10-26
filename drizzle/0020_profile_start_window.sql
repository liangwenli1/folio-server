ALTER TABLE "profiles" ADD COLUMN "start_url" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "window_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "window_width" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "window_height" integer;