ALTER TABLE "groups" ALTER COLUMN "inherit_members" SET DEFAULT false;--> statement-breakpoint
-- Existing people are shown by the part of their email before the @ until they choose a name.
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
UPDATE "users" SET "display_name" = split_part("email", '@', 1);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify" jsonb DEFAULT '{"taskDone":true,"taskFailed":true,"proxyDown":true,"productUpdate":false}'::jsonb NOT NULL;
