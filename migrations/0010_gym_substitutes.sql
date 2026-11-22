-- Борг [4.2]: заміни для 8 вправ, у яких каталог (phase-1.md) мав «—». Лише INSERT, схема не змінюється; пара напрямлена: «чим замінити X».
-- Ідемпотентно: ON CONFLICT DO NOTHING; слаги, яких у БД ще нема (свіжа БД до сиду), дають 0 рядків — тоді пари додасть сид (scripts/seed-core.ts, те саме джерело).
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'goblet-squat' AND s.slug = 'leg-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'goblet-squat' AND s.slug = 'dumbbell-lunge' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'goblet-squat' AND s.slug = 'glute-bridge' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-bench-press' AND s.slug = 'push-up' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-bench-press' AND s.slug = 'incline-dumbbell-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-bench-press' AND s.slug = 'machine-chest-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'pull-up' AND s.slug = 'lat-pulldown' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'pull-up' AND s.slug = 'dumbbell-row' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'barbell-overhead-press' AND s.slug = 'seated-dumbbell-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'barbell-overhead-press' AND s.slug = 'dumbbell-overhead-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-romanian-deadlift' AND s.slug = 'barbell-romanian-deadlift' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-romanian-deadlift' AND s.slug = 'glute-bridge' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-row' AND s.slug = 'seated-cable-row' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-row' AND s.slug = 'barbell-row' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dumbbell-row' AND s.slug = 'dumbbell-reverse-fly' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dips' AND s.slug = 'push-up' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dips' AND s.slug = 'dumbbell-bench-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'dips' AND s.slug = 'machine-chest-press' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'hanging-knee-raise' AND s.slug = 'dead-bug' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO exercise_substitutes (exercise_id, substitute_id) SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = 'hanging-knee-raise' AND s.slug = 'cable-crunch' ON CONFLICT DO NOTHING;
