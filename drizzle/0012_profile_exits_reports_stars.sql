CREATE TABLE "profile_stars" (
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_stars_user_id_profile_id_pk" PRIMARY KEY("user_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "last_exit" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "prev_exit" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "report" jsonb;--> statement-breakpoint
ALTER TABLE "profile_stars" ADD CONSTRAINT "profile_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_stars" ADD CONSTRAINT "profile_stars_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;