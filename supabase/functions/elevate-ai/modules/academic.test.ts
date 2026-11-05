// Pruebas opcionales de los cálculos: `deno test supabase/functions/elevate-ai/modules/academic.test.ts`
import { academicAverage, averageDetails, goalProgress, recentTrend } from "./academic.ts";
import type { AssessmentRow } from "./shared.ts";

let counter = 0;
function row(partial: Partial<AssessmentRow>): AssessmentRow {
  counter += 1;
  return {
    id: `a${counter}`, subject_id: "s1", name: `Eval ${counter}`, type: "formativa",
    score: 10, max_score: 10, weight: null, term: 1,
    date: `2026-10-${String(counter).padStart(2, "0")}`,
    created_at: "2026-10-01T00:00:00Z",
    ...partial
  };
}

function assertClose(actual: number | null, expected: number, epsilon = 1e-9) {
  if (actual === null || Math.abs(actual - expected) > epsilon) {
    throw new Error(`Se esperaba ${expected} y se obtuvo ${actual}`);
  }
}

Deno.test("formativa 70 % + sumativa 30 % (porcentajes)", () => {
  const rows = [
    row({ type: "formativa", score: 9 }), row({ type: "formativa", score: 8 }),
    row({ type: "sumativa", score: 7 })
  ];
  assertClose(academicAverage(rows, 10, { formativa: 70, sumativa: 30 }), 8.05);
});

Deno.test("los pesos como decimales dan el mismo resultado", () => {
  const rows = [row({ type: "formativa", score: 9 }), row({ type: "sumativa", score: 7 })];
  assertClose(
    academicAverage(rows, 10, { formativa: 0.7, sumativa: 0.3 }),
    academicAverage(rows, 10, { formativa: 70, sumativa: 30 })!
  );
});

Deno.test("sin sumativa el promedio es provisional", () => {
  const rows = [row({ type: "formativa", score: 9 })];
  const details = averageDetails(rows, 10, { formativa: 70, sumativa: 30 });
  assertClose(details.average, 9);
  if (!details.provisional || details.missing_categories[0] !== "sumativa") throw new Error("Debía ser provisional");
});

Deno.test("max_score 0 se ignora y no produce NaN", () => {
  const rows = [row({ score: 5, max_score: 0 }), row({ score: 8, max_score: 10 })];
  assertClose(academicAverage(rows, 10, null), 8);
});

Deno.test("la tendencia compara las últimas notas con las anteriores", () => {
  const scores = [6, 6, 6, 9, 9, 9];
  const rows = scores.map(score => row({ score }));
  const trend = recentTrend(rows);
  if (trend.trend !== "up") throw new Error("Debía ser 'up'");
  assertClose(trend.change_pct_points, 30);
});

Deno.test("con pocas notas no hay tendencia", () => {
  const rows = [row({ score: 5 }), row({ score: 9 }), row({ score: 9 })];
  if (recentTrend(rows).trend !== "insufficient_history") throw new Error("Debía faltar historial");
});

Deno.test("avance de meta", () => {
  assertClose(goalProgress(8, 6, 10), 50);
  if (goalProgress(null, 6, 10) !== null) throw new Error("Debía ser null");
});
