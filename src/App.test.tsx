import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("publishes a new marketplace request with support and acceptance criteria", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/request title/i), "Ship Bittrees provider storefront");
    await user.type(screen.getByLabelText(/project/i), "Marketplace");
    await user.type(screen.getByLabelText(/buyer/i), "Bittrees Ops");
    await user.type(screen.getByLabelText(/preferred provider/i), "Bittrees Engineering");
    await user.click(screen.getByRole("button", { name: /publish request/i }));

    expect(screen.getByText("Ship Bittrees provider storefront")).toBeInTheDocument();
    expect(screen.getAllByText(/Provider matched/i).length).toBeGreaterThanOrEqual(1);
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
});
