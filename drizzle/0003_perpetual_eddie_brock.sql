CREATE TABLE `printers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`model` text DEFAULT 'Bambu Lab X2D + AMS 2 Pro' NOT NULL,
	`adapter` text DEFAULT 'bambu-x2d-ams2pro' NOT NULL,
	`serial` text NOT NULL,
	`local_ip` text NOT NULL,
	`bridge_token_hash` text NOT NULL,
	`telemetry` text,
	`last_seen` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_printers_serial` ON `printers` (`serial`);