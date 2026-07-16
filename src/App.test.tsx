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

  it("stages escrow through the mock chain client and reflects a confirmed preview transaction", async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = screen.getByText("Refine lifecycle QA for marketplace requests").closest("article");
    const order = within(card as HTMLElement);
    await user.click(order.getByRole("button", { name: /accept proposal/i }));
    expect(order.getByText(/base sepolia/i)).toBeInTheDocument();

    await user.click(order.getByRole("button", { name: /stage escrow \(simulated\)/i }));

    expect(await order.findByText(/preview tx submitted for escrow funding/i)).toBeInTheDocument();
    expect(await order.findByText(/preview tx confirmed for escrow funding/i)).toBeInTheDocument();
    expect(await order.findByText(/escrow staged/i)).toBeInTheDocument();
  });

  it("submits delivery through the mock chain client before moving the order to review", async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = screen.getByText("Build the contributor service profile page").closest("article");
    expect(card).not.toBeNull();

    const order = within(card as HTMLElement);
    await user.type(order.getByLabelText(/delivery evidence/i), "PR #42 with screenshots and test output.");
    await user.click(order.getByRole("button", { name: /submit delivery/i }));

    expect(await order.findByText(/preview tx submitted for delivery/i)).toBeInTheDocument();
    expect(await order.findByText(/preview tx confirmed for delivery/i)).toBeInTheDocument();
    expect(await order.findByText(/delivered for review/i)).toBeInTheDocument();
  });

  it("blocks staging escrow for an unsupported asset with a guardrail message", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/request title/i), "Ship an ETH-denominated retainer");
    await user.type(screen.getByLabelText(/project/i), "Marketplace");
    await user.type(screen.getByLabelText(/buyer/i), "Bittrees Ops");
    await user.type(screen.getByLabelText(/preferred provider/i), "Bittrees Engineering");
    await user.selectOptions(screen.getByLabelText(/^token$/i), "ETH");
    await user.click(screen.getByRole("button", { name: /publish request/i }));

    const card = screen.getByText("Ship an ETH-denominated retainer").closest("article");
    const order = within(card as HTMLElement);

    expect(order.getByText(/eth is not a supported escrow settlement asset/i)).toBeInTheDocument();
    expect(order.getByRole("button", { name: /stage escrow \(simulated\)/i })).toBeDisabled();
  });

  it("keeps payment release disabled after delivery acceptance", async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = screen.getByText("Package Base Sepolia escrow preflight").closest("article");
    expect(card).not.toBeNull();

    const order = within(card as HTMLElement);
    expect(order.getAllByRole("checkbox").every((checkbox) => checkbox.hasAttribute("disabled"))).toBe(true);

    await user.click(order.getByRole("button", { name: /accept delivery/i }));

    expect(await order.findByText(/preview tx submitted for delivery acceptance/i)).toBeInTheDocument();
    expect(await order.findByText(/preview tx confirmed for delivery acceptance/i)).toBeInTheDocument();
    expect(await order.findByRole("button", { name: /payment release locked until readiness review/i })).toBeDisabled();
  });

  it("separates live, demo, and planned readiness from feature proposals", () => {
    render(<App />);

    const readiness = screen.getByRole("region", { name: /readiness overview/i });
    expect(within(readiness).getByText("Request intake")).toBeInTheDocument();
    expect(within(readiness).getByText("Live")).toBeInTheDocument();
    expect(within(readiness).getByText("Demo")).toBeInTheDocument();
    expect(within(readiness).getAllByText("Planned")).toHaveLength(2);
    expect(screen.queryByText(/launch gate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/launch approval/i)).not.toBeInTheDocument();

    const proposals = screen.getByRole("region", { name: /feature proposals/i });
    expect(within(proposals).getByRole("form", { name: /add feature proposal/i })).toBeInTheDocument();
    expect(within(proposals).getByText("Verified provider profiles")).toBeInTheDocument();
    expect(within(proposals).getByText("Proposal comparison board")).toBeInTheDocument();
  });

  it("adds a feature proposal through the intake form", async () => {
    const user = userEvent.setup();
    render(<App />);

    const proposals = screen.getByRole("region", { name: /feature proposals/i });
    const form = within(proposals).getByRole("form", { name: /add feature proposal/i });

    await user.type(within(form).getByLabelText(/proposal title/i), "Priority provider inbox");
    await user.selectOptions(within(form).getByLabelText(/^status$/i), "In review");
    await user.selectOptions(within(form).getByLabelText(/^priority$/i), "P0");
    await user.type(within(form).getByLabelText(/^value$/i), "Helps buyers compare providers faster.");
    await user.click(within(form).getByRole("button", { name: /add proposal/i }));

    const card = within(proposals).getByText("Priority provider inbox").closest("article");
    expect(card).not.toBeNull();

    const proposalCard = within(card as HTMLElement);
    expect(proposalCard.getByText("In review")).toBeInTheDocument();
    expect(proposalCard.getByText("P0")).toBeInTheDocument();
    expect(proposalCard.getByText("Helps buyers compare providers faster.")).toBeInTheDocument();
  });
});
