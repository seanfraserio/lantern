import React from "react";
import type { Trace } from "../lib/types.js";

export interface CostBreakdownProps {
  traces: Trace[];
}

/**
 * Token cost breakdown by model, workflow, date.
 */
export const CostBreakdown: React.FC<CostBreakdownProps> = ({ traces }) => {
  const totalCost = traces.reduce((sum, t) => sum + t.estimatedCostUsd, 0);
  const totalTokens = traces.reduce(
    (sum, t) => sum + t.totalInputTokens + t.totalOutputTokens,
    0
  );

  // Group by agent
  const byAgent = new Map<string, number>();
  for (const trace of traces) {
    const current = byAgent.get(trace.agentName) ?? 0;
    byAgent.set(trace.agentName, current + trace.estimatedCostUsd);
  }

  return React.createElement("div", { className: "cost-breakdown" },
    React.createElement("h3", null, "Cost Breakdown"),
    React.createElement("div", { className: "cost-summary" },
      React.createElement("div", null, `Total Cost: $${totalCost.toFixed(4)}`),
      React.createElement("div", null, `Total Tokens: ${totalTokens.toLocaleString()}`),
      React.createElement("div", null, `Traces: ${traces.length}`)
    ),
    React.createElement("h4", null, "By Agent"),
    React.createElement("ul", null,
      Array.from(byAgent.entries()).map(([agent, cost]) =>
        React.createElement("li", { key: agent }, `${agent}: $${cost.toFixed(4)}`)
      )
    )
  );
};
