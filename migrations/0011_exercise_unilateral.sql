-- Одиниці вправи (decisions.md, «Одиниці: гантелі й односторонні вправи»): ознака «повтори на кожну сторону».
-- Лише нова колонка зі значенням 0 і заповнення двох односторонніх вправ каталогу; workout_sets і start_weights не чіпаються.
-- CHECK прямо в ADD COLUMN (exercises не перебудовуємо — на неї вказують FK). Сид (scripts/seed-core.ts) — те саме джерело.
ALTER TABLE `exercises` ADD `unilateral` integer DEFAULT 0 NOT NULL CHECK(`unilateral` IN (0, 1));--> statement-breakpoint
UPDATE `exercises` SET `unilateral` = 1 WHERE `slug` IN ('dumbbell-lunge', 'dumbbell-row');
