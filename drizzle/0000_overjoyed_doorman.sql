CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`project_id` text,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`plates` integer DEFAULT 1 NOT NULL,
	`duration_minutes` integer DEFAULT 60 NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`deadline` text,
	`material` text DEFAULT 'PLA' NOT NULL,
	`color` text DEFAULT '自然色' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
