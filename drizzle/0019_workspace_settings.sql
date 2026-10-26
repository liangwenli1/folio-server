ALTER TABLE "workspaces" ADD COLUMN "default_kernel" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_kernel_version" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_group_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_proxy_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "auto_download_kernels" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "open_detail_after_launch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stop_on_window_close" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "expiry_reminder" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_group_id_groups_id_fk" FOREIGN KEY ("default_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_proxy_id_proxies_id_fk" FOREIGN KEY ("default_proxy_id") REFERENCES "public"."proxies"("id") ON DELETE set null ON UPDATE no action;