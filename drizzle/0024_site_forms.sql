CREATE TABLE "doc_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page" text NOT NULL,
	"helpful" boolean NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_inquiries" ADD COLUMN "number" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_inquiries" ADD COLUMN "kind" text DEFAULT 'product' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_inquiries" ADD CONSTRAINT "sales_inquiries_number_unique" UNIQUE("number");