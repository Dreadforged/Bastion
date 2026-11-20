import { createElement, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/ui/ErrorBoundary.js";

function make(label?: string) {
  const child = createElement("p", null, "ok");
  const boundary = new ErrorBoundary({ children: child, ...(label ? { label } : {}) });
  // Apply state updates directly; there is no DOM in this test environment.
  boundary.setState = (update) => {
    boundary.state = { ...boundary.state, ...(update as object) };
  };
  return { boundary, child };
}

describe("ErrorBoundary", () => {
  it("renders its children until something throws", () => {
    const { boundary, child } = make();
    expect(boundary.render()).toBe(child);
  });

  it("switches to a fallback with a retry button after a crash", () => {
    const { boundary } = make("This channel");
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    const out = boundary.render();
    expect(isValidElement(out)).toBe(true);
    const el = out as ReactElement<{ role: string; children: ReactElement<{ children: string; onClick?: () => void }>[] }>;
    expect(el.props.role).toBe("alert");
    const [message, button] = el.props.children;
    expect(message!.props.children).toContain("This channel");
    expect(button!.props.children).toBe("Try again");
    expect(typeof button!.props.onClick).toBe("function");
  });

  it("shows the children again when retry is pressed", () => {
    const { boundary, child } = make();
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    const out = boundary.render() as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    out.props.children[1]!.props.onClick();
    expect(boundary.render()).toBe(child);
  });

  it("logs the error when it catches one", () => {
    const { boundary } = make();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    boundary.componentDidCatch(new Error("boom"), { componentStack: "at X" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
