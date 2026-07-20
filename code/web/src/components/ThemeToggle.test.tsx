// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "./ThemeToggle.js";

describe("ThemeToggle", () => {
  it("cycles system → light → dark → system", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeToggle preference="system" onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: /system theme/i }));
    expect(onChange).toHaveBeenLastCalledWith("light");

    rerender(<ThemeToggle preference="light" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /light theme/i }));
    expect(onChange).toHaveBeenLastCalledWith("dark");

    rerender(<ThemeToggle preference="dark" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(onChange).toHaveBeenLastCalledWith("system");
  });
});
