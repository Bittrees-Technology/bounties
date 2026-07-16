import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("publishes a new marketplace request with milestone breakdown, support, and acceptance criteria", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/request title/i), "Ship Bittrees provider storefront");
    await user.type(screen.getByLabelText(/project/i), "Marketplace");
    await user.type(screen.getByLabelText(/buyer/i), "Bittrees Ops");
    await user.type(screen.getByLabelText(/preferred provider/i), "Bittrees Engineering");
    await user.clear(screen.getByLabelText(/milestone breakdown/i));
    await user.type(screen.getByLabelText(/milestone breakdown/i), "Discovery phase\nImplementation\nReview");
    await user.click(screen.getByRole("button", { name: /publish request/i }));

    const card = screen.getByText("Ship Bittrees provider storefront").closest("article");
    expect(card).not.toBeNull();

    const order = within(card as HTMLElement);
    expect(order.getByText("Discovery phase")).toBeInTheDocument();
    expect(order.getByText(/Provider matched/i)).toBeInTheDocument();
  });

  it("accepts a provider proposal and shows the simulated escrow action", async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = screen.getByText("Refine lifecycle QA for marketplace requests").closest("article");
    expect(card).not.toBeNull();

    const order = within(card as HTMLElement);
    await user.click(order.getByRole("button", { name: /accept proposal/i }));

    expect(order.getByText(/Provider matched/i)).toBeInTheDocument();
    expect(order.getByText("Frontend Ops")).toBeInTheDocument();
    expect(order.getByRole("button", { name: /stage escrow \(simulated\)/i })).toBeInTheDocument();
  });

  it("keeps payment release disabled after delivery acceptance", async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = screen.getByText("Package Base Sepolia escrow preflight").closest("article");
    expect(card).not.toBeNull();

    const order = within(card as HTMLElement);
    expect(order.getAllByRole("checkbox").every((checkbox) => checkbox.hasAttribute("disabled"))).toBe(true);

    await user.click(order.getByRole("button", { name: /accept delivery/i }));

    expect(order.getByRole("button", { name: /payment release pending launch approval/i })).toBeDisabled();
  });

  it("separates live, demo, and planned readiness from feature proposals", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /market readiness/i })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getAllByText("Planned")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /feature proposals/i })).toBeInTheDocument();
    expect(screen.getByText("Verified provider profiles")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /propose or sponsor this feature/i })).toHaveLength(3);
  });
});
