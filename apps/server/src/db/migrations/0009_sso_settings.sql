CREATE TABLE `sso_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text NOT NULL,
	`label` text DEFAULT 'SSO' NOT NULL,
	`scopes` text DEFAULT 'openid email profile' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`sso_only` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
