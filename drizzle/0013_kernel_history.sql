ALTER TABLE "kernels" ADD COLUMN "recommended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kernels" ADD COLUMN "note" text;--> statement-breakpoint
-- Versions recommended before the history existed count as recommended since they were added.
UPDATE "kernels" SET "recommended_at" = "created_at" WHERE "recommended";
