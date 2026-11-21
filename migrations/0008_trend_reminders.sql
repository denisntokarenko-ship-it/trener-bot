-- Фаза 3 (3.4): kind `trend` у reminders_sent. `reminders_sent_kind` — table-level CHECK (0005), SQLite не розширює його через ALTER:
-- нова таблиця → копія рядків → DROP → RENAME. Написано вручну (як 0003/0006/0007): знімка немає.
CREATE TABLE `reminders_sent_new` (
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`local_date` text NOT NULL,
	`sent_at` integer NOT NULL,
	`message_id` integer,
	PRIMARY KEY(`user_id`, `kind`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reminders_sent_kind" CHECK(`kind` IN ('train', 'weigh', 'report', 'trend')),
	CONSTRAINT "reminders_sent_date" CHECK(`local_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
INSERT INTO `reminders_sent_new` (`user_id`, `kind`, `local_date`, `sent_at`, `message_id`) SELECT `user_id`, `kind`, `local_date`, `sent_at`, `message_id` FROM `reminders_sent`;
--> statement-breakpoint
DROP TABLE `reminders_sent`;
--> statement-breakpoint
ALTER TABLE `reminders_sent_new` RENAME TO `reminders_sent`;
