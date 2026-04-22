CREATE TABLE `file_index` (
	`path` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`inode` integer NOT NULL,
	`sha256` text,
	`mime` text NOT NULL,
	`uploaded_by_user_id` text,
	`indexed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `file_index_parent_idx` ON `file_index` (`path`);