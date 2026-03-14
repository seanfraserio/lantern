import React from "react";

export interface AppProps {
  apiUrl?: string;
}

/**
 * Main dashboard app shell.
 * In a real deployment, this would use React Router for navigation.
 */
export const App: React.FC<AppProps> = ({ apiUrl = "http://localhost:4100" }) => {
  return React.createElement("div", { className: "lantern-dashboard" },
    React.createElement("header", null,
      React.createElement("h1", null, "Lantern"),
      React.createElement("nav", null,
        React.createElement("a", { href: "/traces" }, "Traces"),
        React.createElement("a", { href: "/metrics" }, "Metrics"),
        React.createElement("a", { href: "/alerts" }, "Alerts")
      )
    ),
    React.createElement("main", null,
      React.createElement("p", null, `Connected to: ${apiUrl}`)
    )
  );
};
