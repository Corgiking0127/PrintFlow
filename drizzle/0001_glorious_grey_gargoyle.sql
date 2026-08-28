CREATE INDEX `idx_events_created_at` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_projects_status_deadline` ON `projects` (`status`,`deadline`);