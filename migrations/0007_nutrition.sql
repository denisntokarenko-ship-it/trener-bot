-- Фаза 3 (3.1): харчування, норма КБЖУ, облік витрат на ШІ. Написано вручну (як 0003/0006): знімка 0006 немає, drizzle-kit generate затягнув би чужий дифф.
CREATE TABLE `foods` (
	`id` integer PRIMARY KEY NOT NULL,
	`name_uk` text NOT NULL,
	`kcal_100` integer NOT NULL,
	`protein_100_dg` integer NOT NULL,
	`fat_100_dg` integer NOT NULL,
	`carbs_100_dg` integer NOT NULL,
	`source` text NOT NULL,
	`fdc_ref` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "foods_name_len" CHECK(length("foods"."name_uk") BETWEEN 1 AND 60),
	CONSTRAINT "foods_kcal" CHECK("foods"."kcal_100" BETWEEN 0 AND 900),
	CONSTRAINT "foods_protein" CHECK("foods"."protein_100_dg" BETWEEN 0 AND 1000),
	CONSTRAINT "foods_fat" CHECK("foods"."fat_100_dg" BETWEEN 0 AND 1000),
	CONSTRAINT "foods_carbs" CHECK("foods"."carbs_100_dg" BETWEEN 0 AND 1000),
	CONSTRAINT "foods_macros_sum" CHECK("foods"."protein_100_dg" + "foods"."fat_100_dg" + "foods"."carbs_100_dg" <= 1000),
	CONSTRAINT "foods_source" CHECK("foods"."source" IN ('seed', 'ai_estimate', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `foods_fdc_ref_uq` ON `foods` (`fdc_ref`) WHERE "foods"."fdc_ref" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `food_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`food_id` integer NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "food_aliases_alias" CHECK("food_aliases"."alias" <> '')
);
--> statement-breakpoint
CREATE INDEX `food_aliases_food` ON `food_aliases` (`food_id`);--> statement-breakpoint
CREATE TABLE `meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`status` text NOT NULL,
	`eaten_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`photo_file_id` text,
	`caption` text,
	`ai_model` text NOT NULL,
	`ai_raw_json` text NOT NULL,
	`message_id` integer,
	`await_grams_at` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meals_status" CHECK("meals"."status" IN ('pending', 'confirmed', 'cancelled')),
	CONSTRAINT "meals_local_date" CHECK("meals"."local_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "meals_caption_len" CHECK("meals"."caption" IS NULL OR length("meals"."caption") <= 300),
	CONSTRAINT "meals_raw_len" CHECK(length("meals"."ai_raw_json") <= 8192)
);
--> statement-breakpoint
CREATE INDEX `meals_user_date_status` ON `meals` (`user_id`,`local_date`,`status`);--> statement-breakpoint
CREATE TABLE `meal_items` (
	`meal_id` integer NOT NULL,
	`position` integer NOT NULL,
	`food_id` integer NOT NULL,
	`grams` integer NOT NULL,
	`confidence` text NOT NULL,
	`kcal` integer,
	`protein_dg` integer,
	`fat_dg` integer,
	`carbs_dg` integer,
	PRIMARY KEY(`meal_id`, `position`),
	FOREIGN KEY (`meal_id`) REFERENCES `meals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meal_items_position" CHECK("meal_items"."position" BETWEEN 1 AND 8),
	CONSTRAINT "meal_items_grams" CHECK("meal_items"."grams" BETWEEN 1 AND 2000),
	CONSTRAINT "meal_items_confidence" CHECK("meal_items"."confidence" IN ('low', 'medium', 'high')),
	CONSTRAINT "meal_items_snapshot_nonneg" CHECK("meal_items"."kcal" >= 0 AND "meal_items"."protein_dg" >= 0 AND "meal_items"."fat_dg" >= 0 AND "meal_items"."carbs_dg" >= 0),
	CONSTRAINT "meal_items_snapshot_all_or_none" CHECK(("meal_items"."kcal" IS NULL) = ("meal_items"."protein_dg" IS NULL) AND ("meal_items"."kcal" IS NULL) = ("meal_items"."fat_dg" IS NULL) AND ("meal_items"."kcal" IS NULL) = ("meal_items"."carbs_dg" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `meal_items_food` ON `meal_items` (`food_id`);--> statement-breakpoint
CREATE TABLE `nutrition_targets` (
	`user_id` integer NOT NULL,
	`valid_from` text NOT NULL,
	`kcal` integer NOT NULL,
	`protein_g` integer NOT NULL,
	`fat_g` integer NOT NULL,
	`carbs_g` integer NOT NULL,
	`reason` text NOT NULL,
	`source_date` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `valid_from`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nutrition_targets_valid_from" CHECK("nutrition_targets"."valid_from" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "nutrition_targets_kcal" CHECK("nutrition_targets"."kcal" BETWEEN 800 AND 6000),
	CONSTRAINT "nutrition_targets_macros" CHECK("nutrition_targets"."protein_g" >= 0 AND "nutrition_targets"."fat_g" >= 0 AND "nutrition_targets"."carbs_g" >= 0),
	CONSTRAINT "nutrition_targets_reason" CHECK("nutrition_targets"."reason" IN ('formula', 'trend', 'manual')),
	CONSTRAINT "nutrition_targets_source_date" CHECK("nutrition_targets"."source_date" IS NULL OR "nutrition_targets"."source_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_targets_source_uq` ON `nutrition_targets` (`user_id`,`source_date`) WHERE "nutrition_targets"."source_date" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_micro` integer NOT NULL,
	`purpose` text NOT NULL,
	`local_date` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_usage_tokens" CHECK("ai_usage"."input_tokens" >= 0 AND "ai_usage"."output_tokens" >= 0),
	CONSTRAINT "ai_usage_cost" CHECK("ai_usage"."cost_micro" >= 0),
	CONSTRAINT "ai_usage_purpose" CHECK(length("ai_usage"."purpose") BETWEEN 1 AND 32),
	CONSTRAINT "ai_usage_local_date" CHECK("ai_usage"."local_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE INDEX `ai_usage_user_date` ON `ai_usage` (`user_id`,`local_date`);
