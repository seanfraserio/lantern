import React from "react";
import type { Regression } from "@lantern-ai/sdk";

export interface AlertsPageProps {
  regressions: Regression[];
}

/**
 * Quality regression alerts page.
 */
export const AlertsPage: React.FC<AlertsPageProps> = ({ regressions }) => {
  return React.createElement("div", { className: "alerts-page" },
    React.createElement("h2", null, "Quality Alerts"),
    regressions.length === 0
      ? React.createElement("p", null, "No quality regressions detected.")
      : React.createElement("ul", null,
          regressions.map((r, i) =>
            React.createElement("li", { key: i, className: r.isSignificant ? "alert-critical" : "alert-warning" },
              React.createElement("strong", null, r.scorer),
              `: score dropped from ${r.baseline.toFixed(2)} to ${r.current.toFixed(2)} (Δ${r.delta.toFixed(2)})`
            )
          )
        )
  );
};
