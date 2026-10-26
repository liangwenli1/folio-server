CREATE TABLE "news_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_subscribers_email_unique" UNIQUE("email"),
	CONSTRAINT "news_subscribers_token_unique" UNIQUE("token")
);
--> statement-breakpoint
-- Codes now go by address. They live 15 minutes; any still open are dropped and can be asked for again.
DELETE FROM "email_codes";--> statement-breakpoint
ALTER TABLE "email_codes" DROP CONSTRAINT "email_codes_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "email_codes_user_id_purpose_index";--> statement-breakpoint
ALTER TABLE "email_codes" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
CREATE INDEX "email_codes_email_purpose_index" ON "email_codes" USING btree ("email","purpose");--> statement-breakpoint
ALTER TABLE "email_codes" DROP COLUMN "user_id";