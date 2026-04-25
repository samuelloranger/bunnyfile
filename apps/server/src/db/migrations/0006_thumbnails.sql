CREATE TABLE `thumbnail` (
	`path` text NOT NULL,
	`data` blob NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	PRIMARY KEY(`path`),
	FOREIGN KEY (`path`) REFERENCES `file_index`(`path`) ON UPDATE no action ON DELETE cascade
);
