import React from "react";
import type { Trace } from "../../lib/types.js";

export interface TracesPageProps {
  traces: Trace[];
  onSelectTrace?: (id: string) => void;
}

/**
 * Trace list page with filters.
 */
export const TracesPage: React.FC<TracesPageProps> = ({ traces, onSelectTrace }) => {
  return React.createElement("div", { className: "traces-page" },
    React.createElement("h2", null, "Traces"),
    React.createElement("table", null,
      React.createElement("thead", null,
        React.createElement("tr", null,
          React.createElement("th", null, "ID"),
          React.createElement("th", null, "Agent"),
          React.createElement("th", null, "Status"),
          React.createElement("th", null, "Duration"),
          React.createElement("th", null, "Cost"),
          React.createElement("th", null, "Spans")
        )
      ),
      React.createElement("tbody", null,
        traces.map((trace) =>
          React.createElement("tr", {
            key: trace.id,
            onClick: () => onSelectTrace?.(trace.id),
            style: { cursor: "pointer" },
          },
            React.createElement("td", null, trace.id.slice(0, 8) + "..."),
            React.createElement("td", null, trace.agentName),
            React.createElement("td", null, trace.status),
            React.createElement("td", null, `${trace.durationMs ?? "—"}ms`),
            React.createElement("td", null, `$${trace.estimatedCostUsd.toFixed(4)}`),
            React.createElement("td", null, trace.spans.length)
          )
        )
      )
    )
  );
};
