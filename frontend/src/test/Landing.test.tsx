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

  it("exposes a main landmark distinct from the nav and footer", () => {
    render(<Landing />);
    // A <main> landmark lets screen-reader users skip straight to the primary
    // content past the nav. nav and footer stay as their own landmarks.
    const main = screen.getByRole("main");
    expect(main).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    // The hero heading lives inside the main landmark, not the nav/footer.
    expect(main.querySelector("h1")).not.toBeNull();
    expect(main).toHaveAttribute("id", "main-content");
  });

  it("offers a keyboard skip link targeting the main content", () => {
    render(<Landing />);
    const skip = screen.getByRole("link", { name: /skip to content/i });
    expect(skip).toHaveAttribute("href", "#main-content");
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

  it("does not overstate hosted model availability in the hero trust strip", () => {
    render(<Landing />);
    expect(screen.getByText(/Brain-response scoring/i)).toBeInTheDocument();
    expect(screen.queryByText(/Real TRIBE brain models/i)).not.toBeInTheDocument();
  });
});
