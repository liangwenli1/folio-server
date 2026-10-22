CREATE TABLE "profile_data" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"cookies" integer NOT NULL,
	"storage_bytes" integer NOT NULL,
	"origins" integer NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"saved_by" uuid,
	"device_name" text
);
--> statement-breakpoint
CREATE TABLE "profile_locks" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_name" text,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_data" ADD CONSTRAINT "profile_data_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_data" ADD CONSTRAINT "profile_data_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_locks" ADD CONSTRAINT "profile_locks_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_locks" ADD CONSTRAINT "profile_locks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_locks" ADD CONSTRAINT "profile_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;