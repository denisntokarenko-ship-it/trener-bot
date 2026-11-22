-- Фаза 4 (4.1): пропозиції ШІ (`ai_proposals`) і короткий контекст чату (`chat_turns`). Написано вручну (як 0003/0006/0007/0008): знімка немає.
-- Лише нові таблиці: наявні (ai_usage, nutrition_targets, program_exercises) не змінюються.
CREATE TABLE `ai_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`applied_at` integer,
	`message_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_proposals_kind" CHECK("ai_proposals"."kind" IN ('swap_exercise', 'change_sets_reps', 'adjust_target')),
	CONSTRAINT "ai_proposals_status" CHECK("ai_proposals"."status" IN ('pending', 'accepted', 'rejected', 'expired')),
	CONSTRAINT "ai_proposals_subject" CHECK(length("ai_proposals"."subject_key") BETWEEN 1 AND 32),
	CONSTRAINT "ai_proposals_payload" CHECK(length("ai_proposals"."payload_json") <= 1024 AND json_valid("ai_proposals"."payload_json")),
	CONSTRAINT "ai_proposals_reason" CHECK(length("ai_proposals"."reason") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_proposals_pending_uq` ON `ai_proposals` (`user_id`,`subject_key`) WHERE "ai_proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `ai_proposals_user_status` ON `ai_proposals` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `chat_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_turns_role" CHECK("chat_turns"."role" IN ('user', 'assistant')),
	CONSTRAINT "chat_turns_text" CHECK(length("chat_turns"."text") BETWEEN 1 AND 3500)
);
--> statement-breakpoint
CREATE INDEX `chat_turns_user_id` ON `chat_turns` (`user_id`,`id`);
