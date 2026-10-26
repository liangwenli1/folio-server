CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roles_workspace_id_index" ON "roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_workspace_id_name_index" ON "roles" USING btree ("workspace_id","name");--> statement-breakpoint
INSERT INTO "roles" ("workspace_id", "key", "name", "permissions")
SELECT w."id", r."key", r."name", r."permissions"
FROM "workspaces" w
CROSS JOIN (VALUES
	('owner', 'Owner', ARRAY['profiles.view','profiles.create','profiles.edit','profiles.open','profiles.delete','cookies.import','cookies.export','profiles.export','proxies.view','proxies.bind','proxies.edit','team.manage','activity.view']),
	('admin', 'Admin', ARRAY['profiles.view','profiles.create','profiles.edit','profiles.open','profiles.delete','cookies.import','cookies.export','profiles.export','proxies.view','proxies.bind','proxies.edit','team.manage','activity.view']),
	('member', 'Member', ARRAY['profiles.view','profiles.create','profiles.edit','profiles.open','cookies.import','proxies.view','proxies.bind']),
	('viewer', 'Viewer', ARRAY['profiles.view','proxies.view'])
) AS r("key", "name", "permissions");--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "role_id" uuid;--> statement-breakpoint
UPDATE "memberships" m SET "role_id" = r."id"
FROM "roles" r WHERE r."workspace_id" = m."workspace_id" AND r."key" = m."role";--> statement-breakpoint
UPDATE "invitations" i SET "role_id" = r."id"
FROM "roles" r WHERE r."workspace_id" = i."workspace_id" AND r."key" = i."role";--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_role_id_index" ON "memberships" USING btree ("role_id");--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "role";
