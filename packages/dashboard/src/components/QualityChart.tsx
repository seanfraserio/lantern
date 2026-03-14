import React from "react";
import type { EvalScore } from "../lib/types.js";

export interface QualityChartProps {
  scores: EvalScore[];
}

/**
 * Quality score time series display.
 * Placeholder for a proper charting library integration.
 */
export const QualityChart: React.FC<QualityChartProps> = ({ scores }) => {
  const byScorer = new Map<string, EvalScore[]>();
  for (const score of scores) {
    const existing = byScorer.get(score.scorer) ?? [];
    existing.push(score);
    byScorer.set(score.scorer, existing);
  }

  return React.createElement("div", { className: "quality-chart" },
    React.createElement("h3", null, "Quality Scores"),
    Array.from(byScorer.entries()).map(([scorer, scorerScores]) => {
      const avg = scorerScores.reduce((s, sc) => s + sc.score, 0) / scorerScores.length;
      return React.createElement("div", { key: scorer, className: "scorer-row" },
        React.createElement("span", { className: "scorer-name" }, scorer),
        React.createElement("span", { className: "scorer-avg" }, ` Avg: ${avg.toFixed(2)}`),
        React.createElement("span", { className: "scorer-count" }, ` (${scorerScores.length} samples)`)
      );
    })
  );
};
