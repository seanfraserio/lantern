import React from "react";
import type { Span } from "../lib/types.js";

export interface ReasoningChainProps {
  spans: Span[];
}

/**
 * Visual trace of agent thought steps.
 * Renders spans as a nested tree showing the reasoning chain.
 */
export const ReasoningChain: React.FC<ReasoningChainProps> = ({ spans }) => {
  const rootSpans = spans.filter((s) => !s.parentSpanId);

  const renderSpan = (span: Span, depth: number = 0): React.ReactElement => {
    const children = spans.filter((s) => s.parentSpanId === span.id);
    const indent = depth * 20;

    return React.createElement("div", { key: span.id, style: { marginLeft: indent } },
      React.createElement("div", { className: `span-node span-${span.type}` },
        React.createElement("span", { className: "span-type" }, `[${span.type}]`),
        React.createElement("span", { className: "span-duration" }, ` ${span.durationMs ?? "?"}ms`),
        span.toolName && React.createElement("span", { className: "span-tool" }, ` → ${span.toolName}`),
        span.error && React.createElement("span", { className: "span-error" }, ` ✗ ${span.error}`)
      ),
      children.map((child) => renderSpan(child, depth + 1))
    );
  };

  return React.createElement("div", { className: "reasoning-chain" },
    rootSpans.map((span) => renderSpan(span))
  );
};
