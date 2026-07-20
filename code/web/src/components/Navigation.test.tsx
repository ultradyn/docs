// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { Navigation } from "./Navigation.js";

afterEach(cleanup);

describe("application navigation", () => {
  it("only exposes maintenance when the server enables it", () => {
    const { rerender } = render(
      <MemoryRouter>
        <Navigation maintenanceEnabled={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Maintenance")).toBeNull();

    rerender(
      <MemoryRouter>
        <Navigation maintenanceEnabled />
      </MemoryRouter>,
    );
    expect(screen.getByText("Maintenance")).toBeTruthy();
  });

  it("labels the primary application navigation for assistive technology", () => {
    render(
      <MemoryRouter>
        <Navigation maintenanceEnabled />
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    for (const label of [
      "Ask",
      "Queue",
      "Answer",
      "Sources",
      "Settings",
      "Maintenance",
    ]) {
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("aria-label")).toBe(label);
      expect(link.getAttribute("title")).toBe(label);
    }
  });

  it("always exposes Sources for ingest discovery", () => {
    render(
      <MemoryRouter>
        <Navigation maintenanceEnabled={false} />
      </MemoryRouter>,
    );

    const sources = screen.getByRole("link", { name: "Sources" });
    expect(sources.getAttribute("href")).toBe("/ingest");
    expect(screen.queryByText("Maintenance")).toBeNull();
  });
});
