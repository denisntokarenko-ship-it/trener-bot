-- 0003: назви днів для програм із title IS NULL (страховка: код дня не має потрапляти користувачу). Мапа = DAY_TITLES у src/domain/plan.ts.
UPDATE `program_days` SET `title` = 'Все тіло A' WHERE `code` = 'A' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Все тіло B' WHERE `code` = 'B' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Все тіло A' WHERE `code` = 'FA' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Все тіло B' WHERE `code` = 'FB' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Верх' WHERE `code` = 'UP' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Низ' WHERE `code` = 'LO' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Штовх' WHERE `code` = 'PU' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Тяга' WHERE `code` = 'PL' AND `title` IS NULL;--> statement-breakpoint
UPDATE `program_days` SET `title` = 'Ноги' WHERE `code` = 'LG' AND `title` IS NULL;
