import React from "react";
import type { Span } from "../lib/types.js";

export interface SpanDetailProps {
  span: Span;
}

/**
 * Detailed view of a single span: input, output, tokens, timing.
 */
export const SpanDetail: React.FC<SpanDetailProps> = ({ span }) => {
  return React.createElement("div", { className: "span-detail" },
    React.createElement("h3", null, `Span: ${span.id.slice(0, 8)}...`),
    React.createElement("dl", null,
      React.createElement("dt", null, "Type"),
      React.createElement("dd", null, span.type),
      React.createElement("dt", null, "Duration"),
      React.createElement("dd", null, `${span.durationMs ?? "running"}ms`),
      span.model && React.createElement(React.Fragment, null,
        React.createElement("dt", null, "Model"),
        React.createElement("dd", null, span.model)
      ),
      span.inputTokens !== undefined && React.createElement(React.Fragment, null,
        React.createElement("dt", null, "Input Tokens"),
        React.createElement("dd", null, span.inputTokens)
      ),
      span.outputTokens !== undefined && React.createElement(React.Fragment, null,
        React.createElement("dt", null, "Output Tokens"),
        React.createElement("dd", null, span.outputTokens)
      ),
      span.estimatedCostUsd !== undefined && React.createElement(React.Fragment, null,
        React.createElement("dt", null, "Estimated Cost"),
        React.createElement("dd", null, `$${span.estimatedCostUsd.toFixed(6)}`)
      )
    )
  );
};
