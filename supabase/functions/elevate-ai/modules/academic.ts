// Cálculos académicos puros (sin red ni base de datos), para poder probarlos fácilmente.
//
// Paridad con app.js: el promedio que ve el estudiante en Elevate y el que cita la IA
// deben coincidir. Por eso la lógica de promedios replica la del cliente:
//  - si TODAS las evaluaciones calificadas tienen peso > 0, se pondera; si no, promedio simple;
//  - con varios trimestres, el promedio del año es el promedio de los trimestres;
//  - con category_weights (p. ej. formativa 70 / sumativa 30) cuentan solo las categorías con notas.
// Los pesos de categoría funcionan igual como porcentajes (70/30) o decimales (0.7/0.3):
// solo importa su proporción.

import type { AssessmentRow } from "./shared.ts";

export type CategoryWeights = Record<string, number> | null;

export type AverageDetails = {
  average: number | null;
  /** Categorías con peso que todavía no tienen ninguna nota. */
  missing_categories: string[];
  /** Notas calificadas cuyo tipo no coincide con ninguna categoría (no entran en el promedio). */
  ungrouped_graded: number;
  /** true si el promedio aún puede cambiar porque faltan categorías por calificar. */
  provisional: boolean;
};

export type Trend = {
  trend: "up" | "down" | "stable" | "insufficient_history";
  change_pct_points: number | null;
  recent_avg_pct: number | null;
  previous_avg_pct: number | null;
  compared_evaluations: number;
};

/** Evaluación calificada y con un máximo válido (> 0). */
export function isGraded(row: AssessmentRow): boolean {
  return row.score !== null && row.score !== undefined &&
    Number.isFinite(Number(row.score)) && Number(row.max_score) > 0;
}

export function scorePct(row: AssessmentRow): number {
  return (Number(row.score) / Number(row.max_score)) * 100;
}

export function simpleAverage(rows: AssessmentRow[], scaleMax: number): number | null {
  const graded = rows.filter(isGraded);
  if (!graded.length) return null;
  const weighted = graded.every(row => Number(row.weight) > 0);
  let total = 0, weightTotal = 0;
  for (const row of graded) {
    const weight = weighted ? Number(row.weight) : 1;
    total += (Number(row.score) / Number(row.max_score)) * scaleMax * weight;
    weightTotal += weight;
  }
  return weightTotal ? total / weightTotal : null;
}

export function academicAverage(
  rows: AssessmentRow[],
  scaleMax: number,
  categoryWeights: CategoryWeights
): number | null {
  const graded = rows.filter(isGraded);
  if (!graded.length) return null;
  const terms = [...new Set(graded.map(row => row.term ?? 1))];
  if (terms.length > 1) {
    const averages = terms
      .map(term => academicAverage(graded.filter(row => (row.term ?? 1) === term), scaleMax, categoryWeights))
      .filter((value): value is number => value !== null);
    return averages.length ? averages.reduce((sum, value) => sum + value, 0) / averages.length : null;
  }
  if (!categoryWeights) return simpleAverage(graded, scaleMax);
  let total = 0, weightTotal = 0;
  for (const [category, rawWeight] of Object.entries(categoryWeights)) {
    const weight = Number(rawWeight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const categoryRows = graded.filter(row => (row.type || "").toLowerCase() === category.toLowerCase());
    if (!categoryRows.length) continue;
    const average = simpleAverage(categoryRows, scaleMax);
    if (average === null) continue;
    total += average * weight;
    weightTotal += weight;
  }
  return weightTotal ? total / weightTotal : null;
}

export function averageDetails(
  rows: AssessmentRow[],
  scaleMax: number,
  categoryWeights: CategoryWeights
): AverageDetails {
  const average = academicAverage(rows, scaleMax, categoryWeights);
  if (!categoryWeights) {
    return { average, missing_categories: [], ungrouped_graded: 0, provisional: false };
  }
  const graded = rows.filter(isGraded);
  const categories = Object.keys(categoryWeights);
  const lower = new Set(categories.map(category => category.toLowerCase()));
  const missing = categories.filter(category =>
    !graded.some(row => (row.type || "").toLowerCase() === category.toLowerCase())
  );
  const ungrouped = graded.filter(row => !lower.has((row.type || "").toLowerCase())).length;
  return {
    average,
    missing_categories: missing,
    ungrouped_graded: ungrouped,
    provisional: average !== null && missing.length > 0
  };
}

const sortKey = (row: AssessmentRow) => row.date || row.created_at;

/**
 * Tendencia reciente: compara las últimas evaluaciones calificadas con las anteriores
 * (ventanas de hasta 3, ordenadas por fecha), en puntos porcentuales de la nota de cada evaluación.
 * No usa el promedio acumulado, que cambia muy poco con una sola nota nueva.
 * Es una señal orientativa: no aplica pesos de categoría y no es el promedio de la materia.
 */
export function recentTrend(
  rows: AssessmentRow[],
  options: { maxWindow?: number; minEvaluations?: number; thresholdPoints?: number } = {}
): Trend {
  const maxWindow = options.maxWindow ?? 3;
  const minEvaluations = options.minEvaluations ?? 4;
  const threshold = options.thresholdPoints ?? 5;
  const graded = rows.filter(isGraded).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  if (graded.length < minEvaluations) {
    return {
      trend: "insufficient_history", change_pct_points: null,
      recent_avg_pct: null, previous_avg_pct: null, compared_evaluations: 0
    };
  }
  const windowSize = Math.min(maxWindow, Math.floor(graded.length / 2));
  const recent = graded.slice(-windowSize);
  const previous = graded.slice(-windowSize * 2, -windowSize);
  const mean = (list: AssessmentRow[]) => list.reduce((sum, row) => sum + scorePct(row), 0) / list.length;
  const recentAvg = mean(recent);
  const previousAvg = mean(previous);
  const change = recentAvg - previousAvg;
  return {
    trend: change > threshold ? "up" : change < -threshold ? "down" : "stable",
    change_pct_points: Math.round(change * 100) / 100,
    recent_avg_pct: Math.round(recentAvg * 100) / 100,
    previous_avg_pct: Math.round(previousAvg * 100) / 100,
    compared_evaluations: windowSize
  };
}

/** Avance de una meta (0–100) según el promedio actual. */
export function goalProgress(current: number | null, start: number | null, target: number | null): number | null {
  if (current === null || start === null || target === null || !(target > 0)) return null;
  return target <= start
    ? Math.min(100, (current / target) * 100)
    : Math.max(0, Math.min(100, ((current - start) / (target - start)) * 100));
}
