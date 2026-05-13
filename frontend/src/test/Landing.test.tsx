import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Landing } from "../Landing";

describe("Landing", () => {
  it("renders the brand wordmark", () => {
    render(<Landing />);
    // Multiple "stimli" instances on the page (nav + footer); use getAllByText.
    expect(screen.getAllByText(/stimli/i).length).toBeGreaterThan(0);
  });

  it("renders the primary hero CTA pointing at the workbench", () => {
    render(<Landing />);
    const ctas = screen.getAllByRole("link", { name: /Run a comparison/i });
    expect(ctas[0]).toHaveAttribute("href", "/app");
  });

  it("renders the four signal cards", () => {
    const { container } = render(<Landing />);
    const signalNames = Array.from(container.querySelectorAll(".signal-name")).map((el) => el.textContent);
    expect(signalNames).toEqual(["Hook", "Memory", "Attention", "Load"]);
  });

  it("renders the proof strip stats", () => {
    render(<Landing />);
    expect(screen.getByText(/\$8\.4k/)).toBeInTheDocument();
    expect(screen.getByText(/5 modes/)).toBeInTheDocument();
  });
});
