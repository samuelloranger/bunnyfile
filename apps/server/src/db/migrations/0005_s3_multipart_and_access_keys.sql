CREATE TABLE `s3_multipart_upload` (
	`upload_id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `s3_mpu_bucket_key_idx` ON `s3_multipart_upload` (`bucket`, `key`);
--> statement-breakpoint
CREATE TABLE `s3_multipart_part` (
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`size` integer NOT NULL,
	`md5` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`upload_id`, `part_number`),
	FOREIGN KEY (`upload_id`) REFERENCES `s3_multipart_upload`(`upload_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `s3_access_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`access_key_id` text NOT NULL UNIQUE,
	`secret_key_encrypted` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `s3_access_key_user_id_idx` ON `s3_access_key` (`user_id`);
--> statement-breakpoint
CREATE INDEX `s3_access_key_access_key_id_idx` ON `s3_access_key` (`access_key_id`);
