CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`status` text NOT NULL,
	`commit_sha` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "deployments_status_check" CHECK("deployments"."status" in ('queued', 'building', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `deployments_by_app` ON `deployments` (`app_id`,`created_at`,`id`);