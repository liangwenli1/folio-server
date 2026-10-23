CREATE TABLE "kernels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"platform" text NOT NULL,
	"archive" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"url" text,
	"object_key" text,
	"recommended" boolean DEFAULT false NOT NULL,
	"ready" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kernels" ADD CONSTRAINT "kernels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kernels_kind_version_platform_index" ON "kernels" USING btree ("kind","version","platform");--> statement-breakpoint
-- The engine versions the desktop app shipped with, from their upstream releases (sizes and checksums as published).
INSERT INTO "kernels" ("kind", "version", "platform", "archive", "size", "sha256", "url", "recommended") VALUES
('chromium', '150.0.7871.186', 'linux-x64', 'tar.xz', 145806232, '48eff860053efd9ad498d51370f0a1f59f983df39c02a72ad2a8682cdead4055', 'https://github.com/adryfish/fingerprint-chromium/releases/download/150.0.7871.186/ungoogled-chromium-150.0.7871.186-1-x86_64_linux.tar.xz', true),
('chromium', '150.0.7871.186', 'win32-x64', 'zip', 193743241, '4d549c326e51ebbabf562fd365eb5380d9d4a81200da2c60f075c688d9a77e03', 'https://github.com/adryfish/fingerprint-chromium/releases/download/150.0.7871.186/ungoogled-chromium_150.0.7871.186-1.1_windows_x64.zip', true),
('chromium', '148.0.7778.215', 'darwin-arm64', 'dmg', 140187500, 'b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679', 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/ungoogled-chromium_148.0.7778.215-1.1_macos.dmg', true),
('chromium', '148.0.7778.215', 'darwin-x64', 'dmg', 140187500, 'b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679', 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/ungoogled-chromium_148.0.7778.215-1.1_macos.dmg', true),
('firefox', '156.0.1-beta.36', 'linux-x64', 'zip', 1294875941, '72637885ee67c93466ad377831c647192f8f08fb5c6fd9279de1320b49dd2b53', 'https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.36/camoufox-156.0.1-beta.36-lin.x86_64.zip', true),
('firefox', '156.0.1-beta.36', 'win32-x64', 'zip', 1311638126, '096fd4832a7a32f2aa7f7bdd07fe6253dda296cbe783acd7bc2c86cf5ae62031', 'https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.36/camoufox-156.0.1-beta.36-win.x86_64.zip', true),
('firefox', '156.0.1-beta.36', 'darwin-arm64', 'zip', 1289762241, '0ad5663e40f4a2a836e28747256b79f39a5105905f1b244139a7a391f85fda32', 'https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.36/camoufox-156.0.1-beta.36-mac.arm64.zip', true),
('firefox', '156.0.1-beta.36', 'darwin-x64', 'zip', 1297187860, 'abe133d2b1c7a8afe5a6af5f44adfd3169b16d4cc2268e99a81a41a6853f5782', 'https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.36/camoufox-156.0.1-beta.36-mac.x86_64.zip', true);
