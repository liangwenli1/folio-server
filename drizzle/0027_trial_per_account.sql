ALTER TABLE "users" ADD COLUMN "trial_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The trial moves from the workspace to its owner's account: whoever owns a workspace that had it has had it.
UPDATE "users" SET "trial_used" = true WHERE "id" IN (
  SELECT m."user_id" FROM "memberships" m
  JOIN "roles" r ON r."id" = m."role_id" AND r."key" = 'owner'
  JOIN "subscriptions" s ON s."workspace_id" = m."workspace_id" AND s."trial_used"
);--> statement-breakpoint
-- Payments keep the plan they replaced, for refunds; that state no longer carries the flag.
UPDATE "payments" SET "previous" = "previous" - 'trialUsed';--> statement-breakpoint
ALTER TABLE "subscriptions" DROP COLUMN "trial_used";
