ALTER TABLE "groups" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "proxies" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "auto_download_kernels";