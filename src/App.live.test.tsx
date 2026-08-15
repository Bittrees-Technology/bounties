import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { configureMockAcceptedUnfundedBuyer, configureMockEscrowRecordOutcome, configureMockEscrowRecordOutcomes, configureMockEscrowRefreshOnchainState, configureMockEscrowStateRefreshRejected, configureMockMilestoneEscrow, configureMockOpenBountyWithApplicantForBuyer, configureMockSelectedUnfundedProvider, configureMockSettledEscrow, configureMockSettlementProposal, configureMockWalletChain, configureMockWalletEscrowStateReads } from "./test/setup";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

it("checks pending escrow confirmation without holding the global updating state", async () => {
  configureMockAcceptedUnfundedBuyer();
  configureMockEscrowRecordOutcome("pending");
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
  await user.click(await screen.findByRole("button", { name: /check funding confirmation/i }));

  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/bounties/escrow"))).toHaveLength(1));
  expect(screen.queryByText(/updating bounties/i)).not.toBeInTheDocument();
  expect(screen.getByText(/locked against another funding attempt/i)).toBeInTheDocument();
  expect(await screen.findByText(/will check again in the background/i)).toBeInTheDocument();
});

it("automatically resumes a hydrated lock and reveals lifecycle actions after confirmation", async () => {
  configureMockAcceptedUnfundedBuyer();
  configureMockEscrowRecordOutcomes(["pending", "success"]);
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  window.localStorage.setItem("bounties.escrow-creation-locks.v1", JSON.stringify({
    "00000000-0000-4000-8000-000000000421": { txHash: `0x${"99".repeat(32)}`, createdAt: new Date().toISOString() }
  }));
  const retryDelays = new Set([4_000, 8_000, 16_000, 30_000, 60_000, 90_000]);
  const nativeSetTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
    nativeSetTimeout(handler, retryDelays.has(Number(timeout)) ? 0 : timeout, ...args)
  )) as typeof window.setTimeout);
  window.history.replaceState({}, "", "/marketplace");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  const card = (await screen.findByRole("heading", { name: /buyer unfunded escrow/i })).closest("article") as HTMLElement;
  await user.click(within(card).getByRole("link", { name: /view bounty/i }));

  expect(await screen.findByRole("button", { name: /cancel and refund before provider acceptance/i })).toBeInTheDocument();
  expect(window.localStorage.getItem("bounties.escrow-creation-locks.v1")).toBe("{}");
  expect(screen.queryByText(/updating bounties/i)).not.toBeInTheDocument();
});

it("surfaces terminal canonical mismatches, retains the lock, and stops automatic retries", async () => {
  configureMockAcceptedUnfundedBuyer();
  configureMockEscrowRecordOutcome("mismatch");
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
  await user.click(await screen.findByRole("button", { name: /check funding confirmation/i }));

  expect(await screen.findByText(/onchain terms commitment does not match this bounty.s current accepted terms/i)).toBeInTheDocument();
  expect(screen.getByText(/locked against another funding attempt/i)).toBeInTheDocument();
  expect(window.localStorage.getItem("bounties.escrow-creation-locks.v1")).not.toBe("{}");
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/bounties/escrow"))).toHaveLength(1));
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
  const workGuidance = order.getByRole("complementary", { name: /work submission/i });
  const settlement = order.getByRole("region", { name: /optional mutual settlement/i });
  const proofComposer = order.getByRole("form", { name: /delivery proof composer for phase two/i });
  const lifecycleControls = order.getByRole("group", { name: /escrow lifecycle controls/i });
  const reviewPanel = order.getByRole("region", { name: /reviews for two-phase active milestone/i });

  expect(digest).toHaveAttribute("pattern", "0x[a-fA-F0-9]{64}");
  expect(digest).toHaveAttribute("minlength", "66");
  expect(digest).toHaveAttribute("maxlength", "66");
  expect(order.getByText(/hash the exact delivered file.*do not hash the link/i)).toBeInTheDocument();
  expect(order.getByRole("button", { name: /submit work evidence/i })).toBeInTheDocument();
  expect(order.getByText(/submit completed work/i)).toBeInTheDocument();
  expect(within(proofComposer).getByLabelText(/proof location type/i)).toHaveValue("web");
  expect(within(proofComposer).getByRole("option", { name: /source repository or pull request/i })).toBeInTheDocument();
  expect(within(proofComposer).getByRole("option", { name: /cloud document or folder/i })).toBeInTheDocument();
  expect(within(proofComposer).getByRole("option", { name: /ipfs content/i })).toBeInTheDocument();
  expect(within(proofComposer).getByRole("option", { name: /arweave content/i })).toBeInTheDocument();
  expect(within(proofComposer).getByRole("option", { name: /onchain transaction/i })).toBeInTheDocument();
  expect(within(proofComposer).getByLabelText(/calculate from a local file/i)).toHaveAttribute("type", "file");
  expect(within(proofComposer).getByLabelText(/delivery description \(optional\)/i)).toHaveAttribute("maxlength", "1000");
  expect(within(proofComposer).getByLabelText(/delivery description \(optional\)/i)).not.toBeRequired();
  expect(within(proofComposer).getByText(/concise plain-text context for the requester/i)).toBeInTheDocument();
  expect(within(proofComposer).getByText(/not part of the onchain evidence commitment/i)).toBeInTheDocument();
  expect(within(proofComposer).getByText(/no file bytes are uploaded/i)).toBeInTheDocument();
  expect(within(proofComposer).getByText(/only this one canonical location is included/i)).toBeInTheDocument();
  expect(order.getByRole("link", { name: /submit proof of completed work/i })).toHaveAttribute("href", "#delivery-00000000-0000-4000-8000-000000000324");
  expect(within(workGuidance).getByText(/submit work evidence for phase two/i)).toBeInTheDocument();
  expect(within(workGuidance).getByText(/active milestone form earlier on this page/i)).toBeInTheDocument();
  expect(within(workGuidance).getByRole("link", { name: /go to evidence form/i })).toHaveAttribute("href", "#delivery-00000000-0000-4000-8000-000000000324");
  expect(within(settlement).getByText(/settle by mutual agreement/i)).toBeInTheDocument();
  expect(within(settlement).getByText(/moves no funds until the other party accepts/i)).toBeInTheDocument();
  expect(within(lifecycleControls).getByRole("button", { name: /refresh canonical escrow state/i })).toBeInTheDocument();
  expect(lifecycleControls.compareDocumentPosition(reviewPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const settlementInput = within(settlement).getByLabelText(/labor provider amount \(USDC\)/i);
  const settlementButton = within(settlement).getByRole("button", { name: /propose settlement split/i });
  const splitEditor = within(settlement).getByRole("group", { name: /exact settlement split/i });
  const capitalShare = within(splitEditor).getByRole("article", { name: /capital provider settlement share/i });
  const laborShare = within(splitEditor).getByRole("article", { name: /labor provider settlement share/i });
  expect(settlementInput).toHaveAttribute("name", "providerPayout");
  expect(settlementButton).toBeDisabled();
  expect(within(splitEditor).getAllByRole("article")[0]).toBe(capitalShare);
  expect(capitalShare).not.toHaveTextContent(/\d+\s*\/\s*\d+/);
  expect(laborShare).not.toHaveTextContent(/\d+\s*\/\s*\d+/);
  const settlementUser = userEvent.setup();
  await settlementUser.type(settlementInput, "75.123456");
  expect(capitalShare).toHaveTextContent("74.876544 / 150 USDC");
  expect(laborShare).toHaveTextContent("75.123456 / 150 USDC");
  expect(capitalShare).not.toHaveTextContent("250 USDC");
  expect(settlementButton).toBeEnabled();
  await settlementUser.clear(settlementInput);
  await settlementUser.type(settlementInput, "150.000001");
  expect(within(settlement).getByRole("alert")).toHaveTextContent(/cannot exceed the remaining escrow/i);
  expect(capitalShare).not.toHaveTextContent(/\d+\s*\/\s*\d+/);
  expect(laborShare).not.toHaveTextContent(/\d+\s*\/\s*\d+/);
  expect(settlementButton).toBeDisabled();
  expect(order.getByLabelText(/funded escrow/i)).toHaveTextContent(/250 USDC/i);
  expect(order.getByRole("link", { name: /funded.*view funding transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"77".repeat(32)}`));
  expect(within(order.getByLabelText(/funded escrow/i)).getByRole("link", { name: /^view funding transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"77".repeat(32)}`));
  const finalDue = order.getAllByText(/^Due /i).at(-1)?.textContent?.replace(/^Due /i, "");
  expect(order.getByText(/Delivery by/i)).toHaveTextContent(finalDue!);
});

it("offers one provider acceptance action and reveals proof only after its receipt is canonical", async () => {
  configureMockMilestoneEscrow("Funded", "Pending", "2099-12-31T23:59:59.999Z", "match", "provider");
  configureMockWalletEscrowStateReads([null, "Funded", "ProviderAccepted"]);
  const order = await renderConfiguredEscrow();

  expect(order.getAllByRole("button", { name: /accept bounty terms to begin work/i })).toHaveLength(1);
  expect(order.queryByRole("button", { name: /accept committed bounty terms/i })).not.toBeInTheDocument();
  expect(order.queryByLabelText(/work evidence link/i)).not.toBeInTheDocument();

  configureMockEscrowRefreshOnchainState("ProviderAccepted");
  await userEvent.setup().click(order.getByRole("button", { name: /accept bounty terms to begin work/i }));

  expect(await order.findByLabelText(/work evidence link/i)).toBeInTheDocument();
  expect(order.queryByRole("button", { name: /accept bounty terms/i })).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/bounties/escrow/state"))).toHaveLength(2);
  expect(vi.mocked(window.ethereum!.request).mock.calls.some(([request]) => request.method === "eth_getTransactionReceipt")).toBe(true);
});

it("repairs a stale funded provider view from canonical state when the bounty opens", async () => {
  configureMockMilestoneEscrow("Funded", "Pending", "2099-12-31T23:59:59.999Z", "match", "provider");
  configureMockWalletEscrowStateReads(["ProviderAccepted"]);
  configureMockEscrowStateRefreshRejected();
  const order = await renderConfiguredEscrow();

  expect(await order.findByLabelText(/work evidence link/i)).toBeInTheDocument();
  expect(order.queryByRole("button", { name: /accept bounty terms/i })).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/bounties/escrow/state"))).toHaveLength(1);
  expect(vi.mocked(window.ethereum!.request).mock.calls.some(([request]) => request.method === "eth_sendTransaction")).toBe(false);
});

it("preflights a stale acceptance control and never resends an already accepted transaction", async () => {
  configureMockMilestoneEscrow("Funded", "Pending", "2099-12-31T23:59:59.999Z", "match", "provider");
  configureMockWalletEscrowStateReads([null, "ProviderAccepted"]);
  configureMockEscrowStateRefreshRejected();
  const order = await renderConfiguredEscrow();
  configureMockWalletChain("0x1");

  await userEvent.setup().click(order.getByRole("button", { name: /accept bounty terms to begin work/i }));

  expect(await order.findByLabelText(/work evidence link/i)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/terms were already accepted onchain.*without sending another transaction/i);
  const walletMethods = vi.mocked(window.ethereum!.request).mock.calls.map(([request]) => request.method);
  expect(walletMethods.indexOf("wallet_switchEthereumChain")).toBeLessThan(walletMethods.lastIndexOf("eth_call"));
  expect(walletMethods).not.toContain("eth_sendTransaction");
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
  expect(order.getByText(/only the counterparty can accept this exact split before/i)).toBeInTheDocument();
  const currentProposal = order.getByRole("complementary", { name: /current settlement proposal/i });
  const proposalShares = within(currentProposal).getAllByRole("article");
  expect(proposalShares[0]).toHaveAccessibleName(/capital provider settlement share/i);
  expect(proposalShares[0]).toHaveTextContent("75 / 150 USDC");
  expect(proposalShares[1]).toHaveAccessibleName(/labor provider settlement share/i);
  expect(proposalShares[1]).toHaveTextContent("75 / 150 USDC");
  expect(currentProposal).not.toHaveTextContent(/base units/i);
});

it("does not offer acceptance for an expired counterparty proposal", async () => {
  configureMockSettlementProposal("provider", "2000-01-01T00:00:00.000Z");
  const order = await renderConfiguredEscrow();
  expect(order.queryByRole("button", { name: /accept current exact split/i })).not.toBeInTheDocument();
  expect(order.getByText(/proposal has expired and cannot be accepted/i)).toBeInTheDocument();
});

it("shows an exact terminal settlement receipt and unlocks participant reviews", async () => {
  configureMockSettledEscrow();
  const order = await renderConfiguredEscrow();
  const receipt = order.getByRole("region", { name: /^settlement completed$/i });
  const shares = within(receipt).getAllByRole("article");

  expect(within(receipt).getByRole("heading", { name: /^settlement completed$/i })).toBeInTheDocument();
  expect(shares[0]).toHaveAccessibleName(/capital provider settlement share/i);
  expect(shares[0]).toHaveTextContent("74.876544 / 150 USDC");
  expect(shares[1]).toHaveAccessibleName(/labor provider settlement share/i);
  expect(shares[1]).toHaveTextContent("75.123456 / 150 USDC");
  expect(receipt).toHaveTextContent(/Base Sepolia/);
  expect(receipt).toHaveTextContent(/Final onchain statusSettled/);
  expect(receipt).toHaveTextContent(/Final escrow balance0 USDC/);
  expect(within(receipt).getByRole("link", { name: /view settlement transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"99".repeat(32)}`));
  expect(order.queryByRole("region", { name: /optional mutual settlement/i })).not.toBeInTheDocument();
  expect(order.queryByLabelText(/labor provider amount/i)).not.toBeInTheDocument();
  expect(order.queryByRole("button", { name: /propose settlement|accept current exact split|cancel my settlement proposal/i })).not.toBeInTheDocument();
  expect(order.getByLabelText(/original funded escrow/i)).toHaveTextContent(/original escrow funded.*settlement completed on Base Sepolia.*Settled/i);
  expect(within(order.getByLabelText(/original funded escrow/i)).getByRole("link", { name: /view original funding transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"77".repeat(32)}`));
  expect(within(order.getByRole("list", { name: /bounty progress/i })).getByText(/^Settlement completed$/i).closest("li")).toHaveClass("current");
  expect(order.getByText(/both parties can now review the work and payment experience/i)).toBeInTheDocument();
  expect(order.getByLabelText(/rate the labor provider/i)).toBeInTheDocument();
  expect(order.getByRole("button", { name: /publish review/i })).toBeInTheDocument();
});

it("withholds terminal party amounts instead of inferring them from cleared proposal storage", async () => {
  configureMockSettledEscrow(false);
  const order = await renderConfiguredEscrow();
  const receipt = order.getByRole("region", { name: /^settlement completed$/i });

  expect(within(receipt).getByRole("status")).toHaveTextContent(/verified settlement-event allocation is still being indexed/i);
  expect(within(receipt).queryByRole("article")).not.toBeInTheDocument();
  expect(within(receipt).queryByRole("link", { name: /settlement transaction/i })).not.toBeInTheDocument();
  expect(receipt).toHaveTextContent(/verified settlement transaction link is not available/i);
  expect(receipt).toHaveTextContent(/Final escrow balance0 USDC/);
  expect(order.queryByRole("region", { name: /optional mutual settlement/i })).not.toBeInTheDocument();
});

it("replaces settlement acceptance controls after receipt-backed canonical refresh", async () => {
  configureMockSettlementProposal("provider", "2099-12-30T00:00:00.000Z");
  configureMockEscrowRefreshOnchainState("Settled");
  configureMockWalletEscrowStateReads(["ProviderAccepted", "Settled"]);
  const order = await renderConfiguredEscrow();
  const user = userEvent.setup();

  await user.click(await order.findByRole("button", { name: /accept current exact split/i }));

  const receipt = await order.findByRole("region", { name: /^settlement completed$/i });
  expect(within(receipt).getByRole("link", { name: /view settlement transaction/i })).toHaveAttribute("href", expect.stringContaining(`/tx/0x${"99".repeat(32)}`));
  expect(order.queryByRole("button", { name: /accept current exact split/i })).not.toBeInTheDocument();
  expect(order.queryByRole("region", { name: /optional mutual settlement/i })).not.toBeInTheDocument();
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
