ALTER TABLE "extensions" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "proxies" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "proxies" ADD COLUMN "last_exit" jsonb;--> statement-breakpoint
-- Proxies already checked start their history (and, if it got through, their last exit) from that check.
UPDATE "proxies" SET "history" = jsonb_build_array(jsonb_build_object('at', "last_check"->>'checkedAt', 'ok', ("last_check"->>'ok')::boolean, 'ms', "last_check"->'ms')) WHERE "last_check" IS NOT NULL;--> statement-breakpoint
UPDATE "proxies" SET "last_exit" = jsonb_build_object('ip', "last_check"->'ip', 'geo', "last_check"->'geo', 'at', "last_check"->>'checkedAt') WHERE ("last_check"->>'ok')::boolean;
