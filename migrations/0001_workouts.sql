CREATE TABLE `exercise_substitutes` (
	`exercise_id` integer NOT NULL,
	`substitute_id` integer NOT NULL,
	PRIMARY KEY(`exercise_id`, `substitute_id`),
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`substitute_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "exercise_substitutes_not_self" CHECK("exercise_substitutes"."exercise_id" <> "exercise_substitutes"."substitute_id")
);
--> statement-breakpoint
CREATE TABLE `exercises` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name_uk` text NOT NULL,
	`equipment` text NOT NULL,
	`weight_step_kg` real NOT NULL,
	`min_weight_kg` real NOT NULL,
	`muscle_group` text NOT NULL,
	`cues_uk` text NOT NULL,
	`video_url` text,
	CONSTRAINT "exercises_slug_kebab" CHECK("exercises"."slug" <> '' AND "exercises"."slug" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "exercises_equipment" CHECK("exercises"."equipment" IN ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight')),
	CONSTRAINT "exercises_muscle_group" CHECK("exercises"."muscle_group" IN ('legs', 'chest', 'back', 'shoulders', 'core')),
	CONSTRAINT "exercises_min_weight" CHECK("exercises"."min_weight_kg" >= 0),
	CONSTRAINT "exercises_step" CHECK(("exercises"."equipment" = 'bodyweight' AND "exercises"."weight_step_kg" = 0 AND "exercises"."min_weight_kg" = 0) OR ("exercises"."equipment" <> 'bodyweight' AND "exercises"."weight_step_kg" > 0)),
	CONSTRAINT "exercises_cues_3_lines" CHECK(length("exercises"."cues_uk") - length(replace("exercises"."cues_uk", char(10), '')) = 2 AND instr("exercises"."cues_uk", char(10) || char(10)) = 0 AND substr("exercises"."cues_uk", 1, 1) <> char(10) AND substr("exercises"."cues_uk", -1, 1) <> char(10))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercises_slug_unique` ON `exercises` (`slug`);--> statement-breakpoint
CREATE TABLE `program_days` (
	`id` integer PRIMARY KEY NOT NULL,
	`program_id` integer NOT NULL,
	`code` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_days_code_len" CHECK(length("program_days"."code") BETWEEN 1 AND 8)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_days_program_code` ON `program_days` (`program_id`,`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `program_days_program_position` ON `program_days` (`program_id`,`position`);--> statement-breakpoint
CREATE TABLE `program_exercises` (
	`id` integer PRIMARY KEY NOT NULL,
	`program_day_id` integer NOT NULL,
	`exercise_id` integer NOT NULL,
	`position` integer NOT NULL,
	`sets` integer NOT NULL,
	`rep_min` integer NOT NULL,
	`rep_max` integer NOT NULL,
	FOREIGN KEY (`program_day_id`) REFERENCES `program_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_exercises_sets" CHECK("program_exercises"."sets" BETWEEN 1 AND 10),
	CONSTRAINT "program_exercises_rep_min" CHECK("program_exercises"."rep_min" >= 1),
	CONSTRAINT "program_exercises_rep_max" CHECK("program_exercises"."rep_max" >= "program_exercises"."rep_min" AND "program_exercises"."rep_max" <= 50)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_exercises_day_position` ON `program_exercises` (`program_day_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `program_exercises_day_exercise` ON `program_exercises` (`program_day_id`,`exercise_id`);--> statement-breakpoint
CREATE TABLE `programs` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "programs_active" CHECK("programs"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `programs_one_active` ON `programs` (`user_id`) WHERE active = 1;--> statement-breakpoint
CREATE TABLE `workout_sets` (
	`id` integer PRIMARY KEY NOT NULL,
	`workout_id` integer NOT NULL,
	`program_exercise_id` integer NOT NULL,
	`exercise_id` integer NOT NULL,
	`set_no` integer NOT NULL,
	`weight_kg` real,
	`reps` integer,
	`prescribed_weight_kg` real NOT NULL,
	`prescribed_reps` integer NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workout_id`) REFERENCES `workouts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_exercise_id`) REFERENCES `program_exercises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workout_sets_set_no" CHECK("workout_sets"."set_no" BETWEEN 1 AND 10),
	CONSTRAINT "workout_sets_skipped" CHECK("workout_sets"."skipped" IN (0, 1)),
	CONSTRAINT "workout_sets_values" CHECK(("workout_sets"."skipped" = 1 AND "workout_sets"."weight_kg" IS NULL AND "workout_sets"."reps" IS NULL) OR ("workout_sets"."skipped" = 0 AND "workout_sets"."weight_kg" IS NOT NULL AND "workout_sets"."reps" IS NOT NULL AND "workout_sets"."weight_kg" >= 0 AND "workout_sets"."reps" BETWEEN 0 AND 50))
);
--> statement-breakpoint
CREATE INDEX `workout_sets_exercise_workout` ON `workout_sets` (`exercise_id`,`workout_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sets_workout_exercise_set` ON `workout_sets` (`workout_id`,`exercise_id`,`set_no`);--> statement-breakpoint
CREATE TABLE `workouts` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`program_day_id` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`effort` integer,
	`note` text,
	`await_input` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_day_id`) REFERENCES `program_days`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workouts_status" CHECK("workouts"."status" IN ('active', 'done', 'abandoned')),
	CONSTRAINT "workouts_effort" CHECK("workouts"."effort" BETWEEN 1 AND 5),
	CONSTRAINT "workouts_finished_iff_not_active" CHECK(("workouts"."status" = 'active') = ("workouts"."finished_at" IS NULL)),
	CONSTRAINT "workouts_done_iff_effort" CHECK(("workouts"."status" = 'done') = ("workouts"."effort" IS NOT NULL)),
	CONSTRAINT "workouts_await_only_active" CHECK("workouts"."await_input" IS NULL OR "workouts"."status" = 'active')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workouts_one_active` ON `workouts` (`user_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `workouts_user_started` ON `workouts` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `workouts_status_started` ON `workouts` (`status`,`started_at`);