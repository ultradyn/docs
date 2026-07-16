import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { App, ApplicationErrorFallback } from "./App.js";
import "./styles.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Ultradyn Docs UI failed", error, info.componentStack);
  }

  render() {
    return this.state.failed ? (
      <ApplicationErrorFallback />
    ) : (
      this.props.children
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Application root not found");

createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
