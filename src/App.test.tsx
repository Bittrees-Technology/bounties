import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { configureMockMilestoneEscrow, configureMockStaff } from "./test/setup";

afterEach(() => cleanup());

async function connectWallet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
  expect(await screen.findByText(/post bounties, provide services, or do both/i)).toBeInTheDocument();
  expect(window.sessionStorage.getItem("bounties.csrf")).toBe("csrf-test");
}

async function openCreatePage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^create bounty$/i }));
  expect(screen.getByRole("heading", { name: /create a bounty people can deliver/i })).toBeInTheDocument();
}

async function completeCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  tokenName: RegExp = /USDC/i
) {
  await user.type(screen.getByLabelText(/bounty title/i), title);
  await user.type(screen.getByLabelText(/project/i), "Marketplace");
  await user.type(screen.getByLabelText(/review contact/i), "Marketplace Ops");
  await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: tokenName }));
}

async function publishBounty(user: ReturnType<typeof userEvent.setup>, title = "Ship provider storefront", tokenName: RegExp = /USDC/i) {
  await openCreatePage(user);
  await completeCreateForm(user, title, tokenName);
  await user.click(screen.getByRole("button", { name: /publish bounty/i }));
  return within((await screen.findByRole("heading", { name: title })).closest("article") as HTMLElement);
}

describe("App", () => {
  it("separates marketplace and creation while requiring wallet auth only for actions", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getAllByRole("button", { name: /^connect wallet$/i })).toHaveLength(1);
    expect(screen.queryByText(/explore bounties, then sign in when you.re ready/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/won.t send a transaction or give bounties access to your tokens/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^marketplace$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^marketplace$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create bounty$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /check a token/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bounty title/i)).not.toBeInTheDocument();

    await openCreatePage(user);
    expect(screen.getByLabelText(/bounty title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet to inspect/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet to publish/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add custom token/i })).toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
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

  it("accepts fractional token budgets with an exact deliverable allocation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    await user.clear(screen.getByLabelText(/budget/i));
    await user.type(screen.getByLabelText(/budget/i), "1.5");
    await user.clear(screen.getByLabelText(/^amount$/i));
    await user.type(screen.getByLabelText(/^amount$/i), "1.5");
    await completeCreateForm(user, "Fractional bounty");
    await user.click(screen.getByRole("button", { name: /publish bounty/i }));
    const order = within((await screen.findByRole("heading", { name: "Fractional bounty" })).closest("article") as HTMLElement);
    expect(order.getByText(/1.5 USDC/i)).toBeInTheDocument();
  });

  it("preserves an exact 18-decimal budget from input through persisted display", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    const exact = "0.123456789012345678";
    await user.clear(screen.getByLabelText(/budget/i));
    await user.type(screen.getByLabelText(/budget/i), exact);
    await user.clear(screen.getByLabelText(/^amount$/i));
    await user.type(screen.getByLabelText(/^amount$/i), exact);
    await completeCreateForm(user, "Exact decimal bounty", /WETH/i);
    await user.click(screen.getByRole("button", { name: /publish bounty/i }));
    const order = within((await screen.findByRole("heading", { name: "Exact decimal bounty" })).closest("article") as HTMLElement);
    expect(order.getByText(/0\.123456789012345678 WETH/i)).toBeInTheDocument();
  });

  it("does not present an unconfigured WETH symbol as verified ETH", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    expect(screen.getByRole("option", { name: /WETH test token.*WETH.*Base Sepolia.*0x2222/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ETH \(backed by verified WETH\)/i })).not.toBeInTheDocument();
  });

  it("keeps every inspected ERC20 available by network and contract identity without chain IDs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    expect(screen.getByRole("option", { name: /CUSTOM.*Base Sepolia/i })).toBeInTheDocument();
    expect(screen.queryByText(/84532/)).not.toBeInTheDocument();
  });

  it("loads separate participant roles on a public wallet profile and limits editing to its owner", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("button", { name: /^my profile$/i }));

    expect(await screen.findByRole("heading", { name: /test participant/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /as a capital provider/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /as a labor provider/i })).toBeInTheDocument();
    await user.click(screen.getByText(/edit my public profile/i));
    await user.clear(screen.getByLabelText(/display name/i));
    await user.type(screen.getByLabelText(/display name/i), "Updated participant");
    await user.click(screen.getByRole("button", { name: /save public profile/i }));
    expect(await screen.findByRole("heading", { name: /updated participant/i })).toBeInTheDocument();

    await user.click(screen.getByText(/report this profile/i));
    await user.selectOptions(screen.getByLabelText(/^concern$/i), "Illegal or prohibited activity");
    await user.type(screen.getByLabelText(/details.*optional/i), "Prohibited service promotion");
    await user.click(screen.getByRole("button", { name: /submit report/i }));
    expect(await screen.findByText(/report received/i)).toBeInTheDocument();
    const reportCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/api/bounties/reports"));
    expect(JSON.parse(String(reportCall?.[1]?.body))).toMatchObject({
      entityType: "profile",
      entityId: "00000000-0000-4000-8000-000000000111"
    });
    await user.click(screen.getByRole("button", { name: /^marketplace$/i }));
    expect(screen.getByText(/^Profile report$/i)).toBeInTheDocument();
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

  it("fails closed on acceptance without an independently derivable approval commitment", async () => {
    configureMockMilestoneEscrow("BuyerApproved", "Approved");
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    const order = within((await screen.findByRole("heading", { name: /two-phase active milestone/i })).closest("article") as HTMLElement);

    expect(within(order.getByText("Phase two").closest(".milestone-row") as HTMLElement).getByText(/active milestone/i)).toBeInTheDocument();
    expect(order.queryByRole("button", { name: /accept completed work/i })).not.toBeInTheDocument();
    expect(within(order.getByText("Phase one").closest(".milestone-row") as HTMLElement).queryByRole("button", { name: /accept completed work/i })).not.toBeInTheDocument();
  });

  it("shows moderation decisions only inside an explicitly authorized workspace", async () => {
    configureMockStaff("moderator", [{
      id: "00000000-0000-4000-8000-000000000888",
      entity_type: "bounty",
      entity_id: "00000000-0000-4000-8000-000000000123",
      reason: "Potentially illegal service",
      status: "open",
      version: 1,
      created_at: new Date().toISOString()
    }, {
      id: "00000000-0000-4000-8000-000000000889",
      entity_type: "profile",
      entity_id: "00000000-0000-4000-8000-000000000111",
      entity_title: "Profile 0x1111111111111111111111111111111111111111",
      content: { type: "profile", wallet_address: "0x1111111111111111111111111111111111111111" },
      reason: "Prohibited profile content",
      status: "open",
      version: 1,
      created_at: new Date().toISOString()
    }]);
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("button", { name: /^moderator$/i }));
    expect(screen.getAllByRole("heading", { name: /moderator panel/i })).toHaveLength(2);
    expect(screen.getByText(/^Authorized moderator$/i)).toBeInTheDocument();
    expect(screen.getByText(/do not affect escrow, payment, or blockchain records/i)).toBeInTheDocument();
    expect(screen.getByText(/potentially illegal service/i)).toBeInTheDocument();
    expect(screen.getByText(/Profile report.*Profile 0x1111/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view reported profile/i })).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /keep visible.*no action/i })).toHaveLength(2);
    expect(screen.getAllByLabelText(/message to reporter/i)).toHaveLength(2);
  });
});
