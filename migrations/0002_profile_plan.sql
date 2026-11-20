CREATE TABLE `onboarding_state` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`step` text NOT NULL,
	`sub` integer DEFAULT 0 NOT NULL,
	`msg_id` integer,
	`plan_variant` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "onboarding_state_status" CHECK("onboarding_state"."status" IN ('active', 'done')),
	CONSTRAINT "onboarding_state_step" CHECK("onboarding_state"."step" IN ('welcome', 'goal', 'goal_note', 'level', 'days', 'minutes', 'place', 'limits', 'limits_note', 'lifts', 'sex', 'birth', 'height', 'weight', 'meals', 'diet', 'sleep', 'activity', 'plan')),
	CONSTRAINT "onboarding_state_sub" CHECK("onboarding_state"."sub" BETWEEN 0 AND 3),
	CONSTRAINT "onboarding_state_variant" CHECK("onboarding_state"."plan_variant" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE `start_weights` (
	`user_id` integer NOT NULL,
	`exercise_id` integer NOT NULL,
	`weight_kg` real NOT NULL,
	`reps` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `exercise_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "start_weights_weight" CHECK("start_weights"."weight_kg" >= 0),
	CONSTRAINT "start_weights_reps" CHECK("start_weights"."reps" BETWEEN 1 AND 30)
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`goal` text,
	`goal_note` text,
	`level` text,
	`days_per_week` integer,
	`session_min` integer,
	`place` text,
	`limits` text,
	`limits_note` text,
	`sex` text,
	`birth_year` integer,
	`height_cm` integer,
	`weight_kg` real,
	`meals_per_day` integer,
	`diet_note` text,
	`sleep_band` text,
	`activity` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_profiles_goal" CHECK("user_profiles"."goal" IS NULL OR "user_profiles"."goal" IN ('lose_fat', 'muscle', 'recomp', 'strength', 'health', 'other')),
	CONSTRAINT "user_profiles_goal_note" CHECK("user_profiles"."goal_note" IS NULL OR length("user_profiles"."goal_note") <= 300),
	CONSTRAINT "user_profiles_level" CHECK("user_profiles"."level" IS NULL OR "user_profiles"."level" IN ('novice', 'mid', 'adv')),
	CONSTRAINT "user_profiles_days" CHECK("user_profiles"."days_per_week" IS NULL OR "user_profiles"."days_per_week" BETWEEN 2 AND 5),
	CONSTRAINT "user_profiles_session_min" CHECK("user_profiles"."session_min" IS NULL OR "user_profiles"."session_min" IN (30, 45, 60, 90)),
	CONSTRAINT "user_profiles_place" CHECK("user_profiles"."place" IS NULL OR "user_profiles"."place" IN ('gym', 'home')),
	CONSTRAINT "user_profiles_limits" CHECK("user_profiles"."limits" IS NULL OR "user_profiles"."limits" = '' OR ("user_profiles"."limits" NOT LIKE ',%' AND "user_profiles"."limits" NOT LIKE '%,' AND "user_profiles"."limits" NOT LIKE '%,,%' AND replace(replace(replace(replace(replace("user_profiles"."limits", 'knee', ''), 'back', ''), 'shoulder', ''), 'wrist', ''), ',', '') = '')),
	CONSTRAINT "user_profiles_limits_note" CHECK("user_profiles"."limits_note" IS NULL OR length("user_profiles"."limits_note") <= 300),
	CONSTRAINT "user_profiles_sex" CHECK("user_profiles"."sex" IS NULL OR "user_profiles"."sex" IN ('m', 'f')),
	CONSTRAINT "user_profiles_birth_year" CHECK("user_profiles"."birth_year" IS NULL OR "user_profiles"."birth_year" BETWEEN 1930 AND 2020),
	CONSTRAINT "user_profiles_height" CHECK("user_profiles"."height_cm" IS NULL OR "user_profiles"."height_cm" BETWEEN 120 AND 230),
	CONSTRAINT "user_profiles_weight" CHECK("user_profiles"."weight_kg" IS NULL OR "user_profiles"."weight_kg" BETWEEN 30 AND 300),
	CONSTRAINT "user_profiles_meals" CHECK("user_profiles"."meals_per_day" IS NULL OR "user_profiles"."meals_per_day" BETWEEN 1 AND 5),
	CONSTRAINT "user_profiles_diet_note" CHECK("user_profiles"."diet_note" IS NULL OR length("user_profiles"."diet_note") <= 300),
	CONSTRAINT "user_profiles_sleep" CHECK("user_profiles"."sleep_band" IS NULL OR "user_profiles"."sleep_band" IN ('lt6', '6_7', '7_8', '8p')),
	CONSTRAINT "user_profiles_activity" CHECK("user_profiles"."activity" IS NULL OR "user_profiles"."activity" IN ('low', 'mid', 'high'))
);
--> statement-breakpoint
-- Нові стовпці каталогу: CHECK прямо в ADD COLUMN (exercises не перебудовуємо — на неї вказують FK).
ALTER TABLE `exercises` ADD `pattern` text CHECK(`pattern` IS NULL OR `pattern` IN ('squat', 'hinge', 'hpush', 'vpush', 'hpull', 'vpull', 'core', 'delt', 'legacc'));--> statement-breakpoint
ALTER TABLE `exercises` ADD `kind` text CHECK(`kind` IS NULL OR `kind` IN ('compound', 'accessory'));--> statement-breakpoint
ALTER TABLE `exercises` ADD `place` text CHECK(`place` IS NULL OR `place` IN ('gym', 'both'));--> statement-breakpoint
ALTER TABLE `exercises` ADD `min_level` integer CHECK(`min_level` IS NULL OR `min_level` BETWEEN 1 AND 3);--> statement-breakpoint
ALTER TABLE `exercises` ADD `stress` text;--> statement-breakpoint
ALTER TABLE `program_days` ADD `title` text CHECK(`title` IS NULL OR length(`title`) <= 40);--> statement-breakpoint
-- Існуючі дні A/B отримують назви; code і workouts.program_day_id не чіпаємо; повторний прогін нічого не міняє.
UPDATE `program_days` SET `title` = 'Все тіло A' WHERE `code` = 'A' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Все тіло B' WHERE `code` = 'B' AND `title` IS NULL;
