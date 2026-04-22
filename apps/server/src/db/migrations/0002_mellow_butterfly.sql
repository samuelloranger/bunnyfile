CREATE TABLE `share_link` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`path` text NOT NULL,
	`expires_at` integer,
	`password_hash` text,
	`max_downloads` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_link_token_unique` ON `share_link` (`token`);
--> statement-breakpoint
CREATE INDEX `share_link_token_idx` ON `share_link` (`token`);
--> statement-breakpoint
CREATE INDEX `share_link_created_by_user_id_idx` ON `share_link` (`created_by_user_id`);
--> statement-breakpoint
CREATE INDEX `share_link_expires_at_idx` ON `share_link` (`expires_at`);
