CREATE TABLE `cron_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_tick_at` integer NOT NULL,
	CONSTRAINT "cron_state_single" CHECK("cron_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `reminders_sent` (
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`local_date` text NOT NULL,
	`sent_at` integer NOT NULL,
	`message_id` integer,
	PRIMARY KEY(`user_id`, `kind`, `local_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reminders_sent_kind" CHECK("reminders_sent"."kind" IN ('train', 'weigh', 'report')),
	CONSTRAINT "reminders_sent_date" CHECK("reminders_sent"."local_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
-- Розклад нагадувань. CHECK — лише тут (schema.ts їх не бачить). Порядок/унікальність днів і «≥ 1 день» перевіряє домен.
ALTER TABLE `users` ADD `training_days` text DEFAULT '1,3,5' NOT NULL CONSTRAINT "users_training_days" CHECK(`training_days` GLOB '[1-7,]*' AND length(`training_days`) >= 1);--> statement-breakpoint
ALTER TABLE `users` ADD `remind_time` text DEFAULT '08:00' CONSTRAINT "users_remind_time" CHECK(`remind_time` IS NULL OR (`remind_time` GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(`remind_time`, 4) IN ('00', '15', '30', '45') AND `remind_time` BETWEEN '05:00' AND '22:00'));--> statement-breakpoint
ALTER TABLE `users` ADD `weigh_time` text DEFAULT '07:30' CONSTRAINT "users_weigh_time" CHECK(`weigh_time` IS NULL OR (`weigh_time` GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(`weigh_time`, 4) IN ('00', '15', '30', '45') AND `weigh_time` BETWEEN '05:00' AND '22:00'));--> statement-breakpoint
-- Бекфіл за днями на тиждень з анкети; профіль створюється на /start, days_per_week може бути NULL — тоді ELSE.
UPDATE `users` SET `training_days` = CASE (SELECT `days_per_week` FROM `user_profiles` WHERE `user_profiles`.`user_id` = `users`.`id`)
  WHEN 2 THEN '1,4' WHEN 3 THEN '1,3,5' WHEN 4 THEN '1,2,4,5' WHEN 5 THEN '1,2,3,4,5' ELSE '1,3,5' END;
