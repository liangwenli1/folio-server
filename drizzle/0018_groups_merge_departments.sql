CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_user_id_index" ON "group_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "inherit_members" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_parent_id_groups_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "groups_parent_id_index" ON "groups" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "group_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Each department becomes a top-level group. A name already taken by a group of the same workspace gets a
-- suffix; `from_department` carries the old id while the rest of the data is moved over, then goes.
ALTER TABLE "groups" ADD COLUMN "from_department" uuid;--> statement-breakpoint
INSERT INTO "groups" ("workspace_id", "name", "color", "created_at", "from_department")
SELECT d."workspace_id",
	CASE WHEN EXISTS (SELECT 1 FROM "groups" g WHERE g."workspace_id" = d."workspace_id" AND g."name" = d."name")
		THEN d."name" || ' (department)' ELSE d."name" END,
	'gray', d."created_at", d."id"
FROM "departments" d;--> statement-breakpoint
INSERT INTO "group_members" ("group_id", "user_id")
SELECT g."id", dm."user_id" FROM "department_members" dm JOIN "groups" g ON g."from_department" = dm."department_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "profiles" p SET "group_id" = g."id"
FROM "groups" g WHERE g."from_department" = p."department_id" AND p."group_id" IS NULL;--> statement-breakpoint
UPDATE "invitations" i SET "group_ids" = sub."ids"
FROM (SELECT i2."id", array_agg(g."id") AS "ids" FROM "invitations" i2
	JOIN "groups" g ON g."from_department" = ANY(i2."department_ids") GROUP BY i2."id") sub
WHERE sub."id" = i."id";--> statement-breakpoint
ALTER TABLE "groups" DROP COLUMN "from_department";--> statement-breakpoint
DROP TABLE "department_members" CASCADE;--> statement-breakpoint
DROP TABLE "departments" CASCADE;--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "department_ids";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "department_id";
