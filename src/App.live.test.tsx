import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { configureMockAcceptedUnfundedBuyer, configureMockEscrowRecordOutcome, configureMockMilestoneEscrow, configureMockOpenBountyWithApplicantForBuyer, configureMockSelectedUnfundedProvider, configureMockSettlementProposal } from "./test/setup";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function renderConfiguredEscrow() {
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  await user.click(await screen.findByRole("link", { name: /^browse bounties$/i }));
  await screen.findByRole("heading", { level: 1, name: /^marketplace$/i });
  const directoryCard = (await screen.findByRole("heading", { name: /two-phase active milestone/i })).closest("article") as HTMLElement;
  await user.click(within(directoryCard).getByRole("link", { name: /view bounty/i }));
  expect(await screen.findByRole("heading", { level: 1, name: /^bounty details$/i })).toBeInTheDocument();
  return within((await screen.findByRole("heading", { level: 2, name: /two-phase active milestone/i })).closest("article") as HTMLElement);
}

it("enables participant escrow creation only when a deployment is configured", async () => {
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();

  render(<App />);
  await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
  await user.click(await screen.findByRole("link", { name: /^browse bounties$/i }));
  await screen.findByRole("heading", { level: 1, name: /^marketplace$/i });
  await user.click(screen.getByRole("link", { name: /^create bounty$/i }));
  await user.type(screen.getByLabelText(/bounty title/i), "Verify escrow observation");
  await user.type(screen.getByLabelText(/^description/i), "Marketplace");
  await user.type(screen.getByLabelText(/contact alias/i), "Marketplace Ops");
  await user.type(screen.getByLabelText(/resources provided/i), "Project brief and source files");
  await user.type(screen.getByLabelText(/acceptance criteria/i), "Delivery matches the approved scope");
  await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: /USDC.*USDC test token/i }));
  await user.click(screen.getByRole("button", { name: /publish bounty/i }));

  const order = within(await screen.findByRole("heading", { name: "Verify escrow observation" }).then((node) => node.closest("article") as HTMLElement));
  expect(order.getByRole("button", { name: /^create and fund escrow$/i })).toBeInTheDocument();
  expect(order.queryByRole("button", { name: /verify escrow observation/i })).not.toBeInTheDocument();
});

it("keeps applicant acceptance visible when immediate wallet funding does not finish", async () => {
  configureMockOpenBountyWithApplicantForBuyer();
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();

  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  await user.click(await screen.findByRole("link", { name: /^browse bounties$/i }));
  const card = (await screen.findByRole("heading", { name: /mobile applicant acceptance/i })).closest("article") as HTMLElement;
  await user.click(within(card).getByRole("link", { name: /view bounty/i }));
  await user.click(await screen.findByRole("button", { name: /accept applicant and fund/i }));

  expect(await screen.findByText(/applicant accepted\. escrow funding did not finish/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /accept applicant/i })).not.toBeInTheDocument();
  expect(screen.getByText(/provider matched/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^create and fund escrow$/i })).toBeInTheDocument();
});

it("keeps new creation paused without hiding existing escrow lifecycle actions", async () => {
  configureMockMilestoneEscrow("ProviderAccepted", "Pending", "2099-12-31T23:59:59.999Z", "match", "provider");
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  await user.click(await screen.findByRole("link", { name: /^browse bounties$/i }));
  const card = (await screen.findByRole("heading", { name: /two-phase active milestone/i })).closest("article") as HTMLElement;
  await user.click(within(card).getByRole("link", { name: /view bounty/i }));
  const order = within((await screen.findByRole("heading", { level: 2, name: /two-phase active milestone/i })).closest("article") as HTMLElement);
  expect(order.queryByText(/new escrow funding is temporarily paused/i)).not.toBeInTheDocument();
  expect(order.getByRole("button", { name: /submit work evidence/i })).toBeInTheDocument();
});

it("keeps predecessor escrow actions bound to the record's verified contract", async () => {
  configureMockMilestoneEscrow("BuyerApproved", "Approved");
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x5555555555555555555555555555555555555555");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  await user.click(await screen.findByRole("link", { name: /^browse bounties$/i }));
  const card = (await screen.findByRole("heading", { name: /two-phase active milestone/i })).closest("article") as HTMLElement;
  await user.click(within(card).getByRole("link", { name: /view bounty/i }));
  const order = within((await screen.findByRole("heading", { level: 2, name: /two-phase active milestone/i })).closest("article") as HTMLElement);

  expect(order.getByRole("button", { name: /accept completed work/i })).toBeInTheDocument();
});

it("hydrates a persisted creation lock and safely clears a reverted receipt", async () => {
  configureMockAcceptedUnfundedBuyer();
  configureMockEscrowRecordOutcome("reverted");
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  window.localStorage.setItem("bounties.escrow-creation-locks.v1", JSON.stringify({
    "00000000-0000-4000-8000-000000000421": { txHash: `0x${"99".repeat(32)}`, createdAt: new Date().toISOString() }
  }));
  window.history.replaceState({}, "", "/marketplace");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  const card = (await screen.findByRole("heading", { name: /buyer unfunded escrow/i })).closest("article") as HTMLElement;
  await user.click(within(card).getByRole("link", { name: /view bounty/i }));
  expect(await screen.findByText(/locked against another funding attempt/i)).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: /check funding confirmation/i }));
  expect(await screen.findByRole("button", { name: /^create and fund escrow$/i })).toBeInTheDocument();
  expect(window.localStorage.getItem("bounties.escrow-creation-locks.v1")).toBe("{}");
});

it("uses the exact active tranche for approval and release controls", async () => {
  configureMockMilestoneEscrow("BuyerApproved", "Approved");
  const order = await renderConfiguredEscrow();
  expect(order.getByText(/active milestone 2 of 2: phase two/i)).toBeInTheDocument();
  expect(order.getByRole("button", { name: /release phase two payment/i })).toBeInTheDocument();
  expect(order.getByRole("button", { name: /accept completed work/i })).toBeInTheDocument();
  expect(order.queryByRole("button", { name: /release full payment/i })).not.toBeInTheDocument();
});

it("uses the active milestone deadline rather than the overall bounty deadline for timeout", async () => {
  configureMockMilestoneEscrow("ProviderAccepted", "Pending", "2000-01-01T00:00:00.000Z");
  const order = await renderConfiguredEscrow();
  expect(order.getByRole("button", { name: /return missed-deadline funds to requester/i })).toBeInTheDocument();
});

it("requires the provider to enter an exact delivered-bytes digest instead of hashing the URI", async () => {
  configureMockMilestoneEscrow("ProviderAccepted", "Pending", "2099-12-31T23:59:59.999Z", "match", "provider");
  const order = await renderConfiguredEscrow();
  const digest = order.getByLabelText(/delivered bytes sha-256/i);

  expect(digest).toHaveAttribute("pattern", "0x[a-fA-F0-9]{64}");
  expect(digest).toHaveAttribute("minlength", "66");
  expect(digest).toHaveAttribute("maxlength", "66");
  expect(order.getByText(/hash the exact delivered file.*do not hash the link/i)).toBeInTheDocument();
  expect(order.getByRole("button", { name: /submit work evidence/i })).toBeInTheDocument();
  expect(order.getByText(/submit completed work/i)).toBeInTheDocument();
  expect(order.getByRole("link", { name: /submit proof of completed work/i })).toHaveAttribute("href", "#delivery-00000000-0000-4000-8000-000000000324");
  expect(order.getByLabelText(/funded escrow/i)).toHaveTextContent(/250 USDC/i);
  expect(order.getByRole("link", { name: /funded.*view funding transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"77".repeat(32)}`));
  expect(within(order.getByLabelText(/funded escrow/i)).getByRole("link", { name: /^view funding transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"77".repeat(32)}`));
  const finalDue = order.getAllByText(/^Due /i).at(-1)?.textContent?.replace(/^Due /i, "");
  expect(order.getByText(/Delivery by/i)).toHaveTextContent(finalDue!);
});

it("shows selected providers why proof submission is locked before funding", async () => {
  configureMockSelectedUnfundedProvider();
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();

  render(<App />);
  await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
  await user.click(await screen.findByRole("link", { name: /^browse bounties$/i }));
  const directoryCard = (await screen.findByRole("heading", { name: /selected unfunded work/i })).closest("article") as HTMLElement;
  await user.click(within(directoryCard).getByRole("link", { name: /view bounty/i }));
  const order = within((await screen.findByRole("heading", { level: 2, name: /selected unfunded work/i })).closest("article") as HTMLElement);
  expect(order.getByRole("link", { name: /unfunded.*view funding status/i })).toHaveAttribute("href", "#escrow-actions-00000000-0000-4000-8000-000000000411");
  expect(order.getByText(/^applicant accepted$/i).closest("li")).toHaveClass("current");
  expect(order.queryByLabelText(/work evidence link/i)).not.toBeInTheDocument();
  expect(order.getByText(/work submission is not open yet/i)).toBeInTheDocument();
  expect(order.getByText(/after funding, accept the committed terms.*proof form will then appear/i)).toBeInTheDocument();
});

it("requires wallet approval before offering offchain acceptance", async () => {
  configureMockMilestoneEscrow("Delivered", "Submitted");
  const order = await renderConfiguredEscrow();
  expect(order.queryByRole("button", { name: /accept completed work/i })).not.toBeInTheDocument();
  expect(order.getByRole("button", { name: /approve phase two onchain/i })).toBeInTheDocument();
});

it("lets the current proposer cancel and never offers acceptance to that proposer", async () => {
  configureMockSettlementProposal("requester", "2099-12-30T00:00:00.000Z");
  const order = await renderConfiguredEscrow();
  expect(order.getByRole("button", { name: /cancel my settlement proposal/i })).toBeInTheDocument();
  expect(order.queryByRole("button", { name: /accept current exact split/i })).not.toBeInTheDocument();
  expect(order.getByText(/only the counterparty can accept it before/i)).toBeInTheDocument();
});

it("does not offer acceptance for an expired counterparty proposal", async () => {
  configureMockSettlementProposal("provider", "2000-01-01T00:00:00.000Z");
  const order = await renderConfiguredEscrow();
  expect(order.queryByRole("button", { name: /accept current exact split/i })).not.toBeInTheDocument();
  expect(order.getByText(/proposal has expired and cannot be accepted/i)).toBeInTheDocument();
});

it("blocks buyer approval when database evidence differs from the active onchain commitment", async () => {
  configureMockMilestoneEscrow("Delivered", "Submitted", "2099-12-31T23:59:59.999Z", "evidence_mismatch");
  const order = await renderConfiguredEscrow();
  expect(order.queryByRole("button", { name: /approve phase two onchain/i })).not.toBeInTheDocument();
  expect(order.queryByRole("button", { name: /release phase two payment/i })).not.toBeInTheDocument();
  expect(order.getAllByRole("alert").some((alert) => /delivery evidence does not match.*refresh canonical escrow state/i.test(alert.textContent ?? ""))).toBe(true);
});

it("blocks offchain acceptance when the canonical approval commitment differs", async () => {
  configureMockMilestoneEscrow("BuyerApproved", "Approved", "2099-12-31T23:59:59.999Z", "approval_mismatch");
  const order = await renderConfiguredEscrow();
  expect(order.queryByRole("button", { name: /accept completed work/i })).not.toBeInTheDocument();
  expect(order.queryByRole("button", { name: /release phase two payment/i })).not.toBeInTheDocument();
  expect(order.getByRole("alert")).toHaveTextContent(/accepted work commitments do not match.*refresh canonical escrow state/i);
});
