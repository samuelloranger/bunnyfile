CREATE TABLE `trash_item` (
  `id` text PRIMARY KEY NOT NULL,
  `original_path` text NOT NULL,
  `trash_path` text NOT NULL,
  `kind` text NOT NULL,
  `size` integer,
  `mime` text,
  `deleted_by_user_id` text,
  `deleted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`deleted_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trash_item_trash_path_unique` ON `trash_item` (`trash_path`);
--> statement-breakpoint
CREATE INDEX `trash_item_deleted_by_user_id_idx` ON `trash_item` (`deleted_by_user_id`);
--> statement-breakpoint
CREATE INDEX `trash_item_deleted_at_idx` ON `trash_item` (`deleted_at`);
