CREATE TABLE "extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kernel" text NOT NULL,
	"version" text NOT NULL,
	"ext_id" text NOT NULL,
	"public_key" text,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"object_key" text NOT NULL,
	"signature" text NOT NULL,
	"source" text NOT NULL,
	"store_id" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "extension_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extensions_workspace_id_index" ON "extensions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extensions_workspace_id_kernel_ext_id_index" ON "extensions" USING btree ("workspace_id","kernel","ext_id");