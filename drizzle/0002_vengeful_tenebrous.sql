ALTER TABLE `projects` ADD `plate_durations` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `plate_names` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `split_by_plate` integer DEFAULT false NOT NULL;