// Призначення на наступну сесію вправи: єдине місце, де історія + робоча вага з анкети зводяться до nextPrescription.
// Його беруть і потік /trening, і нагадування крону — тож «60 кг × 8» в обох місцях завжди однакове.
import type { Exercise, Repo, Slot } from "../db/repo";
import { nextPrescription, type Prescription } from "../domain/progression";

export async function prescribeSlot(repo: Repo, userId: number, exercise: Exercise, slot: Slot): Promise<Prescription> {
  const history = await repo.getExerciseHistory(userId, exercise.id, 3);
  // Робоча вага з анкети діє лише без історії вправи (phase-1b.md, §2).
  return nextPrescription(history, exercise, slot, history.length === 0 ? await repo.getStartWeight(userId, exercise.id) : null);
}
