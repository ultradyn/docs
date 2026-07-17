// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComboBox } from "./ui.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function PriorityComboBox() {
  const [value, setValue] = useState("all");
  return (
    <>
      <ComboBox
        label="Priority tier"
        value={value}
        options={[
          { value: "all", label: "Every tier" },
          { value: "P1", label: "P1 only" },
          { value: "P2", label: "P2 only" },
        ]}
        onChange={setValue}
      />
      <button>Next control</button>
    </>
  );
}

describe("shared UI controls", () => {
  it("selects combobox options with the keyboard and returns focus", async () => {
    const user = userEvent.setup();
    render(<PriorityComboBox />);
    const comboBox = screen.getByRole("combobox", { name: "Priority tier" });

    comboBox.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(comboBox.textContent).toContain("P1 only");
    expect(comboBox.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(comboBox);

    await user.keyboard("{End}{Escape}");
    expect(comboBox.getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("{ArrowDown}{Tab}");
    expect(comboBox.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Next control" }),
    );

    comboBox.focus();
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(comboBox.textContent).toContain("Every tier");
    await user.keyboard("{End}{Home}{Enter}");
    expect(comboBox.textContent).toContain("Every tier");
    await user.keyboard("p ");
    expect(comboBox.textContent).toContain("P1 only");
  });

  it("keeps a long menu open while scrolling and reveals the keyboard-active option", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <ComboBox
        label="Agent to update"
        value="agent-01"
        options={Array.from({ length: 20 }, (_, index) => ({
          value: `agent-${String(index + 1).padStart(2, "0")}`,
          label: `Agent ${index + 1}`,
        }))}
        onChange={() => undefined}
      />,
    );
    const comboBox = screen.getByRole("combobox", {
      name: "Agent to update",
    });

    await user.click(comboBox);
    const listbox = screen.getByRole("listbox", {
      name: "Agent to update options",
    });
    fireEvent.scroll(listbox);
    expect(comboBox.getAttribute("aria-expanded")).toBe("true");

    scrollIntoView.mockClear();
    await user.keyboard("{End}");
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
  });
});
