import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { configureMockStaff } from "./test/setup";

afterEach(() => {
  cleanup();
});

async function connectWallet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /sign in with ethereum/i }));
  expect(await screen.findByText(/post bounties, provide services, or do both/i)).toBeInTheDocument();
  expect(window.sessionStorage.getItem("bounties.csrf")).toBe("csrf-test");
}

async function publishBounty(user: ReturnType<typeof userEvent.setup>, title = "Ship provider storefront", tokenName = /USDC/i) {
  await user.type(screen.getByLabelText(/bounty title/i), title);
  await user.type(screen.getByLabelText(/project/i), "Marketplace");
  await user.type(screen.getByLabelText(/review contact/i), "Marketplace Ops");
  await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: tokenName }));
  await user.click(screen.getByRole("button", { name: /publish bounty/i }));
  return within(await screen.findByRole("heading", { name: title }).then((node) => node.closest("article") as HTMLElement));
}

describe("App", () => {
  it("keeps the product workspace visible and editable while requiring wallet auth for actions", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByText(/explore bounties, then sign in when you.re ready/i)).toBeInTheDocument();
    expect(screen.getByText(/won.t send a transaction or give bounties access to your tokens/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /check a token/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /create a bounty/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /browse bounties/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/bounty title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in to check token/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in to publish/i })).toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/proxy misconfigured/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/bounty title/i), "Audit the creation flow");
    await user.type(screen.getByLabelText(/project name/i), "Bounties");
    expect(screen.getByLabelText(/bounty title/i)).toHaveValue("Audit the creation flow");
    expect(vi.mocked(window.ethereum!.request)).not.toHaveBeenCalled();
  });

  it("connects a wallet and publishes a persisted bounty through the API boundary", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    const order = await publishBounty(user);

    expect(order.getByText(/Marketplace Ops/i)).toBeInTheDocument();
    expect(order.getByText(/250 USDC/i)).toBeInTheDocument();
    expect(order.getByText(/Open request/i)).toBeInTheDocument();
  });

  it("accepts fractional token budgets", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.clear(screen.getByLabelText(/budget/i));
    await user.type(screen.getByLabelText(/budget/i), "1.5");
    const order = await publishBounty(user, "Fractional bounty");

    expect(order.getByText(/1.5 USDC/i)).toBeInTheDocument();
  });

  it("preserves an exact 18-decimal budget from input through persisted display", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.clear(screen.getByLabelText(/budget/i));
    await user.type(screen.getByLabelText(/budget/i), "0.123456789012345678");
    const order = await publishBounty(user, "Exact decimal bounty", /WETH/i);

    expect(order.getByText(/0\.123456789012345678 WETH/i)).toBeInTheDocument();
  });

  it("does not present an unconfigured WETH symbol as verified ETH", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    expect(screen.getByRole("option", { name: /WETH.*unverified token address/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ETH \(backed by verified WETH\)/i })).not.toBeInTheDocument();
  });

  it("keeps every previously inspected ERC20 available by chain and contract identity", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    expect(screen.getByRole("option", { name: /CUSTOM.*chain 84532/i })).toBeInTheDocument();
  });

  it("surfaces the server-side escrow verifier while live settlement is disabled", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    const order = await publishBounty(user, "Verify escrow observation");

    expect(order.getByLabelText(/escrow transaction hash/i)).toBeInTheDocument();
    expect(order.getByRole("button", { name: /verify escrow observation/i })).toBeInTheDocument();
    expect(order.getByText(/API validates required confirmations, the receipt, and canonical create\/fund logs/i)).toBeInTheDocument();
  });

  it("shows consumer-ready report decisions only to shared-role moderators", async () => {
    configureMockStaff("moderator", [{
      id: "00000000-0000-4000-8000-000000000888",
      entity_type: "bounty",
      entity_id: "00000000-0000-4000-8000-000000000123",
      reason: "Potentially illegal service",
      status: "open",
      version: 1,
      created_at: new Date().toISOString()
    }]);
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    expect(screen.getByRole("heading", { name: /content reports/i })).toBeInTheDocument();
    expect(screen.getByText(/do not affect escrow, payment, or blockchain records/i)).toBeInTheDocument();
    expect(screen.getByText(/potentially illegal service/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /keep visible.*no action/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message to reporter/i)).toBeInTheDocument();
  });
});
