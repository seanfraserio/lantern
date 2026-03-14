import React from "react";
import type { Trace, EvalScore } from "../../lib/types.js";
import { CostBreakdown } from "../../components/CostBreakdown.js";
import { QualityChart } from "../../components/QualityChart.js";

export interface MetricsPageProps {
  traces: Trace[];
  scores: EvalScore[];
}

/**
 * Metrics page: quality, cost, latency over time.
 */
export const MetricsPage: React.FC<MetricsPageProps> = ({ traces, scores }) => {
  return React.createElement("div", { className: "metrics-page" },
    React.createElement("h2", null, "Metrics"),
    React.createElement(CostBreakdown, { traces }),
    React.createElement(QualityChart, { scores })
  );
};
