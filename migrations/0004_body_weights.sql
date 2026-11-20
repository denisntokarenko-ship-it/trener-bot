CREATE TABLE `body_weights` (
	`user_id` integer NOT NULL,
	`local_date` text NOT NULL,
	`weight_dg` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "body_weights_dg" CHECK("body_weights"."weight_dg" BETWEEN 300 AND 3000),
	CONSTRAINT "body_weights_date" CHECK("body_weights"."local_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
