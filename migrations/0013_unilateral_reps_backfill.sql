-- Односторонні вправи: до 0011 підпису «на кожну ногу/руку» не було, і власник вводив повтори ЗАГАЛОМ на обидві сторони
-- (його відповідь 2026-11-23). Повтори односторонніх підходів (`exercises.unilateral` = 1) тренувань, початих до деплою
-- правила (версія 7920bc19, 2026-11-23T08:36:28.697Z), ділимо навпіл — на кожну сторону; непарне — вниз (пів повтору не буває).
-- Вага, prescribed_reps (рахував бот з програми), пропущені підходи, двосторонні вправи й пізніші тренування — без змін.
UPDATE `workout_sets` SET `reps` = `reps` / 2
WHERE `skipped` = 0
  AND `reps` IS NOT NULL
  AND `exercise_id` IN (SELECT `id` FROM `exercises` WHERE `unilateral` = 1)
  AND `workout_id` IN (SELECT `id` FROM `workouts` WHERE `started_at` < 1795422988697);
