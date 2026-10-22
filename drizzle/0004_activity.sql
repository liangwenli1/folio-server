CREATE TABLE "activity_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor_id" uuid,
	"device_name" text,
	"action" text NOT NULL,
	"profile_id" uuid,
	"profile_name" text,
	"profile_number" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_workspace_id_seq_index" ON "activity_log" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "activity_log_profile_id_seq_index" ON "activity_log" USING btree ("profile_id","seq");