import React from "react";
import type { Trace } from "../../lib/types.js";
import { ReasoningChain } from "../../components/ReasoningChain.js";
import { SpanDetail } from "../../components/SpanDetail.js";

export interface TraceDetailPageProps {
  trace: Trace;
}

/**
 * Single trace detail page showing the full reasoning chain.
 */
export const TraceDetailPage: React.FC<TraceDetailPageProps> = ({ trace }) => {
  return React.createElement("div", { className: "trace-detail-page" },
    React.createElement("h2", null, `Trace: ${trace.id.slice(0, 12)}...`),
    React.createElement("div", { className: "trace-meta" },
      React.createElement("span", null, `Agent: ${trace.agentName}`),
      React.createElement("span", null, ` | Status: ${trace.status}`),
      React.createElement("span", null, ` | Duration: ${trace.durationMs ?? "—"}ms`),
      React.createElement("span", null, ` | Cost: $${trace.estimatedCostUsd.toFixed(4)}`)
    ),
    React.createElement("h3", null, "Reasoning Chain"),
    React.createElement(ReasoningChain, { spans: trace.spans }),
    React.createElement("h3", null, "Span Details"),
    trace.spans.map((span) =>
      React.createElement(SpanDetail, { key: span.id, span })
    )
  );
};
