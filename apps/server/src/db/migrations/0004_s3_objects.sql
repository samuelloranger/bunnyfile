CREATE TABLE `s3_object` (
	`path` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`size` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`inode` integer NOT NULL,
	`md5` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `s3_object_bucket_idx` ON `s3_object` (`bucket`);
