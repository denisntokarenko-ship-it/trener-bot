CREATE TABLE `processed_updates` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processed_updates_created_at` ON `processed_updates` (`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`tz` text DEFAULT 'Europe/Kyiv' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_first_name_len" CHECK(length("users"."first_name") <= 64)
);
