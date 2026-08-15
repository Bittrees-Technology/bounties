import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SavedDeliveryDescription } from "./DeliveryDescription";

describe("saved delivery description", () => {
  it("renders supporting context as plain text without interpreting HTML", () => {
    render(<SavedDeliveryDescription description={'<img src="x" onerror="alert(1)"> Start review with README.md.'} />);

    expect(screen.getByRole("complementary", { name: /delivery description/i })).toHaveTextContent('<img src="x" onerror="alert(1)"> Start review with README.md.');
    expect(document.querySelector("img")).toBeNull();
  });

  it("does not render an empty description block", () => {
    const { container } = render(<SavedDeliveryDescription description="   " />);
    expect(container).toBeEmptyDOMElement();
  });
});
