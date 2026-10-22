ALTER TABLE "sessions" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "schedule_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runner_device_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runner_device_name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_runner_user_id_users_id_fk" FOREIGN KEY ("runner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_runs_task_id_scheduled_for_index" ON "task_runs" USING btree ("task_id","scheduled_for");