import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { configureMockEscrowAddress, configureMockHiddenStandardToken, configureMockMilestoneEscrow, configureMockProfileLegacySpecialty, configureMockProfileRoleBounties, configureMockStaff } from "./test/setup";

afterEach(() => cleanup());

async function connectWallet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
  expect(window.sessionStorage.getItem("bounties.csrf")).toBe("csrf-test");
  await user.click(screen.getByRole("link", { name: /^browse bounties$/i }));
  expect(await screen.findByRole("heading", { level: 1, name: /^marketplace$/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^my profile$/i })).toBeInTheDocument();
}

async function openCreatePage(user: ReturnType<typeof userEvent.setup>) {
  const primaryNavigation = screen.queryByRole("navigation", { name: /^primary navigation$/i });
  const createLink = primaryNavigation
    ? within(primaryNavigation).getByRole("link", { name: /^create bounty$/i })
    : within(screen.getByRole("heading", { level: 1, name: /fund work deliver results/i }).closest(".landing-hero") as HTMLElement).getByRole("link", { name: /^create a bounty$/i });
  await user.click(createLink);
  expect(screen.getByRole("heading", { name: /^create a bounty$/i })).toBeInTheDocument();
}

async function completeCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  tokenName: RegExp = /USDC.*USDC test token/i
) {
  await user.type(screen.getByLabelText(/bounty title/i), title);
  await user.type(screen.getByLabelText(/^description/i), "Marketplace");
  await user.type(screen.getByLabelText(/contact alias/i), "Marketplace Ops");
  await user.type(screen.getByLabelText(/resources provided/i), "Project brief and source files");
  await user.type(screen.getByLabelText(/acceptance criteria/i), "Delivery matches the approved scope");
  await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: tokenName }));
}

async function publishBounty(user: ReturnType<typeof userEvent.setup>, title = "Ship provider storefront", tokenName: RegExp = /USDC.*USDC test token/i) {
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
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const landingHeading = screen.getByRole("heading", { level: 1, name: "Fund work Deliver results" });
    expect(landingHeading).toBeInTheDocument();
    expect(Array.from(landingHeading.querySelectorAll("span")).map((line) => line.textContent)).toEqual(["Fund work", "Deliver results"]);
    expect(within(landingHeading.closest(".landing-hero") as HTMLElement).queryByText("Token-funded work")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "One bounty One shared record" })).toBeInTheDocument();
    expect(screen.getByText(/create or complete bounties with clear terms, milestones, and payment records/i)).toBeInTheDocument();
    expect(screen.getByText(/connecting a wallet proves ownership only.*never authorizes token spending/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^bounties$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/explore bounties, then sign in when you.re ready/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/won.t send a transaction or give bounties access to your tokens/i)).not.toBeInTheDocument();
    const escrowWorkflow = screen.getByRole("heading", { name: /how the escrow works/i }).closest(".landing-workflow") as HTMLElement;
    expect(Array.from(within(escrowWorkflow).getByRole("list").querySelectorAll("li > strong")).map((step) => step.textContent)).toEqual([
      "Created",
      "Funded",
      "ProviderAccepted",
      "Delivered",
      "BuyerApproved",
      "Released"
    ]);
    const alternativeOutcomes = within(escrowWorkflow).getByLabelText(/alternative escrow outcomes/i);
    expect(within(alternativeOutcomes).getByText("Cancelled")).toBeInTheDocument();
    expect(within(alternativeOutcomes).getByText("Revision")).toBeInTheDocument();
    expect(within(alternativeOutcomes).getByText("Refunded")).toBeInTheDocument();
    expect(within(alternativeOutcomes).getByText("Settled")).toBeInTheDocument();
    expect(Array.from(alternativeOutcomes.querySelectorAll("article > span")).map((outcome) => outcome.textContent)).toEqual([
      "Created / Funded → Cancelled",
      "Delivered → ProviderAccepted",
      "ProviderAccepted → Refunded",
      "Funded / ProviderAccepted / Delivered / BuyerApproved → Settled"
    ]);
    expect(within(escrowWorkflow).getByRole("link", { name: /read the escrow lifecycle/i })).toHaveAttribute("href", expect.stringContaining("contracts/README.md#lifecycle"));
    expect(screen.getByText(/milestone clarity/i)).toBeInTheDocument();
    expect(screen.getByText(/role-specific reputation/i)).toBeInTheDocument();
    const landingHero = landingHeading.closest(".landing-hero") as HTMLElement;
    expect(within(landingHero).getByRole("link", { name: /^browse bounties$/i })).toHaveAttribute("href", "/marketplace");
    expect(within(landingHero).getByRole("link", { name: /^create a bounty$/i })).toHaveAttribute("href", "/create");
    expect(within(landingHero).getByRole("link", { name: /^profiles$/i })).toHaveAttribute("href", "/profiles");
    expect(screen.queryByRole("navigation", { name: /^primary navigation$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /^browse bounties$/i }));
    expect(window.location.pathname).toBe("/marketplace");
    expect(screen.getAllByRole("heading", { name: /^marketplace$/i })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: /^marketplace$/i })).toBeInTheDocument();
    expect(screen.getByText("Browse opportunities, apply with a plan, and follow each bounty from application to accepted work.")).toBeInTheDocument();
    expect(screen.queryByText(/find the right work/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/work with clear terms and visible progress/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/how would you like to participate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/review the scope, timeline, token contract/i)).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /^primary navigation$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^marketplace$/i })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("heading", { name: /how the escrow works/i })).not.toBeInTheDocument();
    expect(screen.getByText(/connect your wallet to view live bounties/i)).toBeInTheDocument();
    expect(screen.getByText(/connecting does not authorize a transaction or token spending/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect to marketplace/i })).toBeInTheDocument();
    expect(screen.queryByText(/illustrative examples/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/review a product onboarding flow/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /escrow docs/i })).toHaveAttribute("href", expect.stringContaining("contracts/README.md"));
    expect(screen.queryByRole("heading", { name: /check a token/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bounty title/i)).not.toBeInTheDocument();

    await openCreatePage(user);
    expect(window.location.pathname).toBe("/create");
    expect(screen.getByRole("link", { name: /^create bounty$/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText(/bounty title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet to add/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect wallet to publish/i })).toBeInTheDocument();
    expect(screen.getByText(/add a custom erc20 token/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /WETH.*Wrapped Ether/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /USDC.*USD Coin/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /bounty details/i })).toBeInTheDocument();
    expect(screen.queryByText(/links beginning with http/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/resources provided/i)).toHaveValue("");
    expect(screen.getByLabelText(/resources provided/i)).toBeRequired();
    expect(screen.getByLabelText(/acceptance criteria/i)).toHaveValue("");
    expect(screen.getByLabelText(/acceptance criteria/i)).toBeRequired();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/bounty title/i), "Audit the creation flow");
    await user.type(screen.getByLabelText(/^description/i), "Bounties");
    expect(screen.getByLabelText(/bounty title/i)).toHaveValue("Audit the creation flow");
    expect(vi.mocked(window.ethereum!.request)).not.toHaveBeenCalled();
  });

  it("keeps the bounty deadline and final delivery date synchronized", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openCreatePage(user);

    const deadline = screen.getByLabelText(/^deadline$/i);
    const deliveryDate = screen.getByLabelText(/^delivery date and time$/i);
    await user.clear(deadline);
    await user.type(deadline, "2099-12-31T17:30");

    expect(deadline).toHaveValue("2099-12-31T17:30");
    expect(deliveryDate).toHaveValue("2099-12-31T17:30");
  });

  it("connects a wallet and publishes a persisted bounty through the API boundary", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    const order = await publishBounty(user);
    expect(order.getByText(/Marketplace Ops/i)).toBeInTheDocument();
    expect(order.getByText(/250 USDC/i)).toBeInTheDocument();
    expect(order.getByText(/Open request/i)).toBeInTheDocument();
    expect(order.queryByText(/source_verification_unavailable/i)).not.toBeInTheDocument();
    expect(order.getByText(/source verification was not available during inspection/i)).toBeInTheDocument();
  });

  it("closes an open listing report after a click outside its controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    const order = await publishBounty(user, "Report interaction boundary");
    const reportSummary = order.getByText(/report this listing/i);
    const reportControl = reportSummary.closest("details") as HTMLDetailsElement;
    const reviewPanel = order.getByRole("heading", { name: /^participant reviews$/i }).closest("section") as HTMLElement;
    expect(reviewPanel.compareDocumentPosition(reportControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(reportSummary);
    expect(reportControl.open).toBe(true);

    await user.click(within(reportControl).getByLabelText(/^concern$/i));
    expect(reportControl.open).toBe(true);
    await user.click(within(reportControl).getByLabelText(/details \(optional\)/i));
    expect(reportControl.open).toBe(true);

    await user.click(within(reportControl).getByText(/details \(optional\)/i));
    expect(reportControl.open).toBe(false);

    await user.click(reportSummary);
    await user.click(order.getByText(/open request/i));
    expect(reportControl.open).toBe(false);
  });

  it("shows a legible, descriptive empty notification state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    const notificationButton = screen.getByRole("button", { name: /^notifications$/i });
    expect(notificationButton).toHaveAttribute("aria-expanded", "false");
    await user.click(notificationButton);

    expect(notificationButton).toHaveAttribute("aria-expanded", "true");
    const notificationRegion = screen.getByRole("region", { name: /^notifications$/i });
    expect(notificationRegion).toHaveClass("notification-popover");
    expect(within(notificationRegion).getByText(/you.re all caught up/i)).toBeInTheDocument();
    expect(within(notificationRegion).getByText(/new activity will appear here/i)).toBeInTheDocument();
    expect(within(notificationRegion).getByText(/0 unread/i)).toBeInTheDocument();
  });

  it("dismisses notifications after an outside click or Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    const notificationButton = screen.getByRole("button", { name: /^notifications$/i });
    await user.click(notificationButton);
    await user.click(within(screen.getByRole("region", { name: /^notifications$/i })).getByText(/you.re all caught up/i));
    expect(screen.getByRole("region", { name: /^notifications$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /^marketplace$/i }));
    expect(screen.queryByRole("region", { name: /^notifications$/i })).not.toBeInTheDocument();
    expect(notificationButton).toHaveAttribute("aria-expanded", "false");

    await user.click(notificationButton);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /^notifications$/i })).not.toBeInTheDocument();
    expect(notificationButton).toHaveFocus();
  });

  it("publishes user-defined work types and categories instead of an Other placeholder", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);

    await user.selectOptions(screen.getByLabelText(/^work type$/i), "__custom__");
    await user.type(screen.getByLabelText(/^custom work type$/i), "Field research");
    await user.selectOptions(screen.getByLabelText(/^category$/i), "__custom__");
    await user.type(screen.getByLabelText(/^custom category$/i), "Ecology and conservation");
    await completeCreateForm(user, "Map urban biodiversity");
    await user.click(screen.getByRole("button", { name: /publish bounty/i }));

    const request = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/bounties/bounties") && init?.method === "POST");
    const body = JSON.parse(String(request?.[1]?.body ?? "{}"));
    expect(body.scopeSource).toMatchObject({
      scope: "Field research",
      category: "Ecology and conservation"
    });
    const order = within((await screen.findByRole("heading", { name: "Map urban biodiversity" })).closest("article") as HTMLElement);
    expect(order.getByText(/Field research · Ecology and conservation/i)).toBeInTheDocument();
    expect(order.queryByText(/^Other$/i)).not.toBeInTheDocument();
  });

  it("keeps account controls at the top and makes milestone creation legible", async () => {
    const user = userEvent.setup();
    render(<App />);
    const toolbar = screen.getByRole("banner", { name: /account controls/i });
    expect(within(toolbar).getByRole("button", { name: /^connect wallet$/i })).toBeInTheDocument();
    expect(toolbar.querySelector(".disconnected-account-actions")).toBeInTheDocument();
    await connectWallet(user);
    expect(toolbar.querySelector(".connected-account-actions")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /0x1111.*disconnect/i })).toBeInTheDocument();
    await openCreatePage(user);
    expect(screen.getByRole("button", { name: /add milestone/i })).toHaveClass("secondary-button", "add-milestone");
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
    await completeCreateForm(user, "Exact decimal bounty", /WETH.*WETH test token/i);
    await user.click(screen.getByRole("button", { name: /publish bounty/i }));
    const order = within((await screen.findByRole("heading", { name: "Exact decimal bounty" })).closest("article") as HTMLElement);
    expect(order.getByText(/0\.123456789012345678 WETH/i)).toBeInTheDocument();
  });

  it("does not present an unconfigured WETH symbol as verified ETH", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    expect(screen.getByRole("option", { name: /WETH.*WETH test token.*Base Sepolia.*0x2222/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ETH \(backed by verified WETH\)/i })).not.toBeInTheDocument();
  });

  it("keeps every inspected ERC20 available by network and contract identity without chain IDs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    expect(screen.getByRole("option", { name: /CUSTOM.*Base Sepolia/i })).toBeInTheDocument();
    expect(screen.queryByText(/84532/)).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /WETH.*Wrapped Ether/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /USDC.*USD Coin/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^BIT · Base Sepolia · 0x4444.*4444$/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /BIT · BIT/i })).not.toBeInTheDocument();
    const paymentTokenLabels = within(screen.getByLabelText(/payment token/i)).getAllByRole("option")
      .slice(1)
      .map((option) => option.textContent ?? "");
    const paymentTokenSymbols = paymentTokenLabels.map((label) => label.split(" · ")[0]);
    expect(paymentTokenSymbols).toEqual([...paymentTokenSymbols].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })));
    expect(paymentTokenLabels.every((label) => label.includes(" · Base Sepolia · 0x"))).toBe(true);
    expect(screen.getByRole("option", { name: /^USDC · USD Coin · Base Sepolia · 0x036c…cf7c$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add weth/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add usdc/i })).not.toBeInTheDocument();
  });

  it("offers custom ERC20 inspection on every supported payment network", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);

    await user.click(screen.getByText(/add a custom erc20 token/i));
    const customNetwork = screen.getByLabelText(/custom token network/i);
    const networkNames = within(customNetwork).getAllByRole("option").map((option) => option.textContent);

    expect(networkNames).toEqual([
      "Ethereum",
      "Ethereum Sepolia",
      "Base",
      "Base Sepolia",
      "Robinhood Chain",
      "Robinhood Chain Testnet"
    ]);

    await user.selectOptions(customNetwork, "1");
    expect(screen.getByLabelText(/payment network/i)).toHaveValue("1");
    expect(screen.getByText(/choose a supported network and enter the token contract address/i)).toBeInTheDocument();
    expect(screen.getByText(/read-only inspection does not certify transfer behavior/i)).toBeInTheDocument();
    expect(screen.getByText(/token value, liquidity, redemption, issuer conduct, and legal status are not guaranteed/i)).toBeInTheDocument();
  });

  it("requires the exact-accounting notice before adding a custom token", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);

    await user.click(screen.getByText(/add a custom erc20 token/i));
    const addButton = screen.getByRole("button", { name: /inspect and add token/i });
    expect(addButton).toBeDisabled();

    await user.type(screen.getByLabelText(/token contract address/i), "0x9999999999999999999999999999999999999999");
    await user.click(screen.getByRole("checkbox", { name: /not a safety or compatibility certification/i }));
    expect(addButton).toBeEnabled();
    await user.click(addButton);

    expect(await screen.findByText(/added as a payment candidate, not certified as safe or transfer-compatible/i)).toBeInTheDocument();
    expect(screen.getByText(/exact accounting is enforced when escrow funding and payouts execute/i)).toBeInTheDocument();
  });

  it("adds a standard payment token directly from the payment dropdown", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);

    await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: /USDC.*USD Coin/i }));

    expect(await screen.findByRole("link", { name: /inspect contract/i })).toHaveAttribute("href", expect.stringContaining("0x036cbd"));
    expect(screen.queryByText(/is ready to use/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/USD Coin \(USDC\)/i).length).toBeGreaterThan(0);
  });

  it("lets a signed-in user flag the selected token as a suspected scam", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);

    await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: /^BIT · Base Sepolia/i }));
    const selectedTokenCard = screen.getByText(/selected token/i).closest(".selected-token-card") as HTMLElement;
    await user.click(within(selectedTokenCard).getByText(/flag this token/i));
    expect(within(selectedTokenCard).getByLabelText(/concern/i)).toHaveValue("Suspected scam token");
    await user.type(within(selectedTokenCard).getByLabelText(/details/i), "Impersonates another asset");
    await user.click(within(selectedTokenCard).getByRole("button", { name: /submit report/i }));

    expect(await screen.findByText(/report received/i)).toBeInTheDocument();
    const reportCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/api/bounties/reports"));
    expect(JSON.parse(String(reportCall?.[1]?.body))).toEqual({
      entityType: "token",
      entityId: "00000000-0000-4000-8000-000000000003",
      reason: "Suspected scam token: Impersonates another asset"
    });
  });

  it("removes moderator-hidden tokens including matching standard presets from payment choices", async () => {
    configureMockHiddenStandardToken();
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);

    expect(screen.queryByRole("option", { name: /^USDC · USD Coin · Base Sepolia/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /USDC · USDC test token · Base Sepolia/i })).toBeInTheDocument();
  });

  it("discovers public profiles by custom or ENS identity", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: /^profiles$/i }));
    expect(screen.getByText(/connect your wallet to browse profiles/i)).toBeInTheDocument();
    expect(screen.queryByText(/a wallet’s work history, in context/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet reputation/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /profile directory/i })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
    expect(await screen.findByRole("link", { name: /^my profile$/i })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("bounties.csrf")).toBe("csrf-test");

    expect(await screen.findByRole("heading", { name: /profile directory/i })).toBeInTheDocument();
    const orderFilter = screen.getByLabelText(/^order$/i);
    const activityFilter = screen.getByLabelText(/^last completed$/i);
    const profileSearchForm = screen.getByRole("button", { name: /^search profiles$/i }).closest("form");
    expect(orderFilter.closest("form")).toBe(profileSearchForm);
    expect(activityFilter.closest("form")).toBe(profileSearchForm);
    expect(orderFilter).toHaveValue("name-asc");
    expect(activityFilter).toHaveValue("any");
    expect(Array.from(document.querySelectorAll(".profile-directory-card h3")).map((heading) => heading.textContent)).toEqual(["Capital guide", "Test participant"]);
    await user.selectOptions(orderFilter, "name-desc");
    expect(Array.from(document.querySelectorAll(".profile-directory-card h3")).map((heading) => heading.textContent)).toEqual(["Test participant", "Capital guide"]);
    await user.selectOptions(activityFilter, "30-days");
    expect(screen.getByText(/1 public profile/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view capital guide profile/i })).not.toBeInTheDocument();
    await user.selectOptions(activityFilter, "any");
    expect(screen.queryByRole("button", { name: /^refresh$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/compare each participant.s marketplace history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ENS names are resolved from Ethereum/i)).not.toBeInTheDocument();
    const ownProfileButton = await screen.findByRole("button", { name: /view test participant profile/i });
    const ownDirectoryCard = ownProfileButton.closest(".profile-directory-card") as HTMLElement;
    expect(within(ownDirectoryCard).queryByText(/public wallet profile/i)).not.toBeInTheDocument();
    const profileView = screen.getByRole("group", { name: /profile view/i });
    const tilesButton = within(profileView).getByRole("button", { name: /^tiles$/i });
    const listButton = within(profileView).getByRole("button", { name: /^list$/i });
    expect(tilesButton).toHaveAttribute("aria-pressed", "true");
    expect(listButton).toHaveAttribute("aria-pressed", "false");
    expect(ownDirectoryCard).toHaveClass("profile-directory-card--tiles");
    expect(ownProfileButton.closest(".profile-directory-card-header")).toBe(ownDirectoryCard.querySelector(".profile-directory-card-header"));
    await user.click(listButton);
    expect(listButton).toHaveAttribute("aria-pressed", "true");
    expect(tilesButton).toHaveAttribute("aria-pressed", "false");
    expect(ownDirectoryCard).toHaveClass("profile-directory-card--list");
    expect(within(ownDirectoryCard).getByRole("button", { name: /view test participant profile/i }).closest(".profile-directory-card-header")).toBeNull();
    expect(ownDirectoryCard.querySelector(".profile-hero")).toBeInTheDocument();
    expect(ownDirectoryCard.querySelector(".profile-identity-meta")).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/^you$/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByRole("link", { name: /view testparticipant\.eth on etherscan/i })).toHaveAttribute("href", "https://etherscan.io/address/0x1111111111111111111111111111111111111111");
    expect(within(ownDirectoryCard).getByRole("link", { name: /^website$/i })).toHaveAttribute("href", "https://example.test/profile");
    expect(within(ownDirectoryCard).queryByText("0x1111…1111")).not.toBeInTheDocument();
    const ownSpecialties = within(ownDirectoryCard).getByLabelText(/test participant specialties/i);
    expect(within(ownSpecialties).getByText(/defined task/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/consultation/i)).toBeInTheDocument();
    expect(within(ownSpecialties).queryByText(/ongoing retainer/i)).not.toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/smart contracts & web3/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/research & writing/i)).toBeInTheDocument();
    expect(within(ownSpecialties).queryByText(/operations & support/i)).not.toBeInTheDocument();
    expect(within(ownSpecialties).getAllByText("+1")).toHaveLength(2);
    const directoryPreferenceGroups = ownSpecialties.querySelectorAll(".profile-specialty-group");
    expect(directoryPreferenceGroups).toHaveLength(2);
    expect(directoryPreferenceGroups[0]).toHaveAttribute("aria-label", "Work types");
    expect(directoryPreferenceGroups[1]).toHaveAttribute("aria-label", "Categories");
    const workTypeLink = within(ownSpecialties).getByRole("link", { name: /^defined task$/i });
    const categoryLink = within(ownSpecialties).getByRole("link", { name: /^smart contracts & web3$/i });
    expect(workTypeLink).toHaveAttribute("href", "/profiles?workType=task");
    expect(categoryLink).toHaveAttribute("href", "/profiles?category=Smart+Contracts+%26+Web3");
    expect(within(ownDirectoryCard).getByText(/^capital$/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/^labor$/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/5\.0 \(3\) · 3 completed/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).queryByText(/total bounties posted or worked/i)).not.toBeInTheDocument();
    const otherProfileButton = screen.getByRole("button", { name: /view capital guide profile/i });
    const otherDirectoryCard = otherProfileButton.closest(".profile-directory-card") as HTMLElement;
    expect(otherDirectoryCard.querySelector(".profile-hero")).toBeInTheDocument();
    expect(otherDirectoryCard.querySelector(".profile-identity-meta")).toBeInTheDocument();
    expect(within(otherDirectoryCard).queryByText(/^you$/i)).not.toBeInTheDocument();
    expect(within(otherDirectoryCard).getByRole("link", { name: /view wallet on etherscan/i })).toHaveAttribute("href", "https://etherscan.io/address/0x2222222222222222222222222222222222222222");
    expect(within(otherDirectoryCard).getByText(/4\.8 \(5\) · 2 posted/i)).toBeInTheDocument();
    expect(screen.getByText(/2 public profiles/i)).toBeInTheDocument();
    expect(screen.queryByText(/public marketplace activity and participant reputation/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/search within/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/^keywords$/i), "testparticipant.eth");
    await user.selectOptions(screen.getByLabelText(/^work type$/i), "audit");
    await user.selectOptions(screen.getByLabelText(/^category$/i), "Smart Contracts & Web3");
    await user.click(screen.getByRole("button", { name: /^search profiles$/i }));

    const searchCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/api/bounties/profiles/search?"));
    const searchUrl = new URL(String(searchCall?.[0]), "https://bounties.bittrees.org");
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      q: "testparticipant.eth",
      workType: "audit",
      category: "Smart Contracts & Web3"
    });

    const result = await screen.findByRole("button", { name: /view test participant profile/i });
    await user.click(result);
    expect(await screen.findByRole("heading", { name: /test participant/i })).toBeInTheDocument();
    const ensLink = screen.getByRole("link", { name: /view testparticipant\.eth on etherscan/i });
    expect(ensLink).toHaveTextContent(/^testparticipant\.eth$/i);
    expect(ensLink).toHaveAttribute("href", "https://etherscan.io/address/0x1111111111111111111111111111111111111111");
    expect(screen.getAllByText(/^testparticipant\.eth$/i)).toHaveLength(1);
    expect(screen.getByRole("link", { name: /^website$/i })).toHaveAttribute("href", "https://example.test/profile");
    expect(screen.queryByText(/^ENS ·/i)).not.toBeInTheDocument();
  });

  it("filters the profile directory from a linked profile category", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: /^profiles$/i }));
    await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);

    const ownProfileButton = await screen.findByRole("button", { name: /view test participant profile/i });
    const ownDirectoryCard = ownProfileButton.closest(".profile-directory-card") as HTMLElement;
    const categoryLink = within(ownDirectoryCard).getByRole("link", { name: /^smart contracts & web3$/i });
    await user.click(categoryLink);

    expect(window.location.pathname).toBe("/profiles");
    expect(new URLSearchParams(window.location.search).get("category")).toBe("Smart Contracts & Web3");
    expect(screen.getByLabelText(/^category$/i)).toHaveValue("Smart Contracts & Web3");
    expect(await screen.findByText(/1 public profile/i)).toBeInTheDocument();
    const linkedFilterCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/api/bounties/profiles/search?category=Smart+Contracts"));
    expect(linkedFilterCall).toBeDefined();
  });

  it("restores a shared profile-preference link after wallet connection", async () => {
    window.history.replaceState({}, "", "/profiles?workType=audit");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);

    expect(await screen.findByRole("heading", { name: /profile directory/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^work type$/i)).toHaveValue("audit");
    expect(await screen.findByText(/1 public profile/i)).toBeInTheDocument();
    const routeFilterCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/api/bounties/profiles/search?workType=audit"));
    expect(routeFilterCall).toBeDefined();
  });

  it("loads separate participant roles on a public wallet profile and limits editing to its owner", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("link", { name: /^my profile$/i }));

    const profileCard = (await screen.findByRole("heading", { name: /test participant/i })).closest(".profile-card") as HTMLElement;
    expect(within(profileCard).queryByText(/public wallet profile/i)).not.toBeInTheDocument();
    const ensAvatar = profileCard.querySelector("img.profile-avatar");
    expect(ensAvatar).toHaveAttribute("src", "https://images.example.test/testparticipant.png");
    fireEvent.error(ensAvatar!);
    expect(profileCard.querySelector("img.profile-avatar")).not.toBeInTheDocument();
    const identityMeta = profileCard.querySelector(".profile-identity-meta") as HTMLElement;
    expect(within(identityMeta).getByRole("link", { name: /view testparticipant\.eth on etherscan/i })).toHaveAttribute("href", "https://etherscan.io/address/0x1111111111111111111111111111111111111111");
    expect(within(identityMeta).queryByText(/0x1111/i)).not.toBeInTheDocument();
    expect(identityMeta.firstElementChild).toHaveTextContent("testparticipant.eth");
    expect(identityMeta.lastElementChild).toHaveTextContent(/website/i);
    expect(within(profileCard).queryByText(/report this profile/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /as a capital provider/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /as a labor provider/i })).toBeInTheDocument();
    const profilePreferences = within(profileCard).getByLabelText(/profile work preferences/i);
    const profilePreferenceGroups = profilePreferences.querySelectorAll(".profile-specialty-group");
    expect(profilePreferenceGroups).toHaveLength(2);
    expect(profilePreferenceGroups[0]).toHaveAttribute("aria-label", "Work types");
    expect(profilePreferenceGroups[1]).toHaveAttribute("aria-label", "Categories");
    const editControl = within(profileCard).getByRole("button", { name: /^edit profile$/i });
    expect(within(profileCard).queryByRole("button", { name: /save public profile/i })).not.toBeInTheDocument();
    expect(within(profileCard).queryByText(/deactivate public profile/i)).not.toBeInTheDocument();
    await user.click(editControl);
    expect(within(profileCard).queryByRole("button", { name: /^edit profile$/i })).not.toBeInTheDocument();
    const saveControl = within(profileCard).getByRole("button", { name: /save public profile/i });
    expect(saveControl).toBeInTheDocument();
    expect(saveControl).not.toBe(editControl);
    expect(saveControl).toHaveAttribute("type", "button");
    expect(saveControl).not.toHaveAttribute("form");
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/api/bounties/profiles/me") && init?.method === "POST")).toHaveLength(0);
    expect(within(profileCard).queryByLabelText(/profile work preferences/i)).not.toBeInTheDocument();
    expect(within(profileCard).getByText(/deactivate public profile/i).closest(".profile-visibility-control")).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/custom profile name/i));
    await user.type(screen.getByLabelText(/custom profile name/i), "Unsaved participant");
    await user.click(screen.getByRole("heading", { name: /as a capital provider/i }));
    expect(within(profileCard).queryByRole("button", { name: /save public profile/i })).not.toBeInTheDocument();
    expect(within(profileCard).getByRole("button", { name: /^edit profile$/i })).toBeInTheDocument();
    expect(within(profileCard).getByRole("heading", { name: /test participant/i })).toBeInTheDocument();
    expect(within(profileCard).getByLabelText(/profile work preferences/i)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/api/bounties/profiles/me") && init?.method === "POST")).toHaveLength(0);

    await user.click(within(profileCard).getByRole("button", { name: /^edit profile$/i }));
    expect(screen.getByLabelText(/custom profile name/i)).toHaveValue("Test participant");
    expect(screen.getByLabelText(/^timezone$/i)).toHaveValue("Europe/Lisbon");
    expect(screen.getByLabelText(/show timezone publicly/i)).not.toBeChecked();
    expect(within(profileCard).queryByLabelText(/profile work preferences/i)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText(/custom profile name/i));
    await user.type(screen.getByLabelText(/custom profile name/i), "Updated participant");
    await user.click(screen.getByLabelText(/show timezone publicly/i));
    await user.click(screen.getByLabelText(/defined task/i));
    await user.click(screen.getByLabelText(/software engineering/i));
    const workTypesGroup = screen.getByRole("group", { name: /^work types$/i });
    const categoriesGroup = screen.getByRole("group", { name: /^categories$/i });
    expect(within(workTypesGroup).queryByLabelText(/other work type 1/i)).not.toBeInTheDocument();
    expect(within(categoriesGroup).queryByLabelText(/other category 1/i)).not.toBeInTheDocument();

    await user.click(within(workTypesGroup).getByLabelText(/other \(optional\)/i));
    await user.type(within(workTypesGroup).getByLabelText(/other work type 1/i), "Incident response");
    await user.click(within(workTypesGroup).getByRole("button", { name: /add another work type/i }));
    await user.type(within(workTypesGroup).getByLabelText(/other work type 2/i), "Protocol documentation");

    await user.click(within(categoriesGroup).getByLabelText(/other \(optional\)/i));
    await user.type(within(categoriesGroup).getByLabelText(/other category 1/i), "Public goods");
    await user.click(within(categoriesGroup).getByRole("button", { name: /add another category/i }));
    await user.type(within(categoriesGroup).getByLabelText(/other category 2/i), "Developer education");
    await user.click(screen.getByRole("button", { name: /save public profile/i }));
    expect(await screen.findByRole("heading", { name: /updated participant/i })).toBeInTheDocument();
    expect(within(profileCard).queryByRole("button", { name: /save public profile/i })).not.toBeInTheDocument();
    expect(within(profileCard).getByRole("button", { name: /^edit profile$/i })).toBeInTheDocument();
    expect(within(profileCard).getByLabelText(/profile work preferences/i)).toBeInTheDocument();

    const profileUpdateCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/bounties/profiles/me") && init?.method === "POST");
    expect(JSON.parse(String(profileUpdateCall?.[1]?.body))).toMatchObject({
      workTypes: expect.arrayContaining(["task", "Incident response", "Protocol documentation"]),
      categories: expect.arrayContaining(["Software Engineering", "Public goods", "Developer education"]),
      customSpecialty: null,
      timezone: "Europe/Lisbon",
      timezonePublic: true
    });

    await user.click(within(profileCard).getByRole("button", { name: /^edit profile$/i }));
    await user.click(screen.getByText(/deactivate public profile/i));
    await user.click(screen.getByRole("button", { name: /hide my profile/i }));
    expect((await screen.findAllByText(/your public profile is hidden/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/profile details, ratings, reviews, and activity remain stored/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /test participant/i })).toBeInTheDocument();
    const hideCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/bounties/profiles/visibility") && init?.method === "POST");
    expect(JSON.parse(String(hideCall?.[1]?.body))).toEqual({ visible: false });

    await user.click(screen.getByRole("button", { name: /reactivate profile/i }));
    expect(await screen.findByText(/public profile is active again/i)).toBeInTheDocument();
    await user.click(within(profileCard).getByRole("button", { name: /^edit profile$/i }));
    expect(screen.getByText(/deactivate public profile/i)).toBeInTheDocument();
    const visibilityCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/bounties/profiles/visibility"));
    expect(JSON.parse(String(visibilityCalls.at(-1)?.[1]?.body))).toEqual({ visible: true });

    const ratingContext = screen.getByText(/capital-provider and labor-provider ratings stay separate/i);
    expect(ratingContext.nextElementSibling).toHaveClass("profile-role-grid");

  }, 10_000);

  it("lists role-specific bounties on a profile and opens the selected marketplace bounty", async () => {
    configureMockProfileRoleBounties();
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("link", { name: /^my profile$/i }));

    const capitalCard = (await screen.findByRole("heading", { name: /as a capital provider/i })).closest(".profile-role-card") as HTMLElement;
    const laborCard = screen.getByRole("heading", { name: /as a labor provider/i }).closest(".profile-role-card") as HTMLElement;
    expect(within(capitalCard).getByText(/0 payment-experience reviews · 1 bounty posted/i)).toBeInTheDocument();
    expect(within(capitalCard).getByRole("link", { name: /capital research bounty/i })).toHaveAttribute(
      "href",
      "/bounties/00000000-0000-4000-8000-000000000610"
    );
    expect(within(laborCard).getByText(/0 service reviews · 1 bounty completed/i)).toBeInTheDocument();
    expect(within(laborCard).getByRole("link", { name: /active audit bounty/i })).toHaveTextContent(/provider accepted onchain/i);
    expect(within(laborCard).getByRole("link", { name: /completed delivery bounty/i })).toHaveTextContent(/paid onchain/i);

    await user.click(within(laborCard).getByRole("link", { name: /active audit bounty/i }));
    expect(window.location.pathname).toBe("/bounties/00000000-0000-4000-8000-000000000620");
    expect(window.location.hash).toBe("");
    expect(await screen.findByRole("heading", { name: /active audit bounty/i })).toBeInTheDocument();
  });

  it("presents a compact filterable bounty directory and opens the full bounty workflow", async () => {
    configureMockMilestoneEscrow("ProviderAccepted", "Pending", "2099-12-31T23:59:59.999Z", "match", "provider");
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    expect(screen.getByRole("heading", { name: /marketplace directory/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^keywords$/i)).toHaveAttribute("placeholder", "Title, description, token, or requester");
    expect(screen.getByLabelText(/^work type$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^category$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^status$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^network$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^order$/i)).toBeInTheDocument();

    const tileCard = screen.getByRole("heading", { level: 3, name: /two-phase active milestone/i }).closest("article") as HTMLElement;
    expect(tileCard).toHaveClass("bounty-directory-card--tiles");
    expect(within(tileCard).getByText(/provider accepted onchain/i)).toBeInTheDocument();
    expect(within(tileCard).queryByLabelText(/work evidence link/i)).not.toBeInTheDocument();
    expect(within(tileCard).getByRole("link", { name: /view bounty/i })).toHaveAttribute(
      "href",
      "/bounties/00000000-0000-4000-8000-000000000321"
    );

    await user.click(within(screen.getByRole("group", { name: /bounty view/i })).getByRole("button", { name: /list/i }));
    expect(screen.getByRole("heading", { level: 3, name: /two-phase active milestone/i }).closest("article")).toHaveClass("bounty-directory-card--list");

    await user.selectOptions(screen.getByLabelText(/^status$/i), "review");
    expect(screen.getByText(/no matching bounties/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^status$/i), "active");

    await user.click(screen.getByRole("link", { name: /view bounty/i }));
    expect(window.location.pathname).toBe("/bounties/00000000-0000-4000-8000-000000000321");
    expect(await screen.findByRole("heading", { level: 1, name: /bounty details/i })).toBeInTheDocument();
    const detailCard = screen.getByRole("heading", { level: 2, name: /two-phase active milestone/i }).closest("article") as HTMLElement;
    expect(within(detailCard).getByText(/^marketplace$/i)).toBeInTheDocument();
    expect(within(detailCard).getByLabelText(/work evidence link/i)).toBeInTheDocument();
    expect(within(detailCard).getByLabelText(/delivered bytes sha-256/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to marketplace/i }));
    expect(window.location.pathname).toBe("/marketplace");
    expect(screen.getByRole("heading", { name: /marketplace directory/i })).toBeInTheDocument();
  });

  it("preserves a legacy specialty as a custom category on the next profile save", async () => {
    configureMockProfileLegacySpecialty("Protocol documentation");
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("link", { name: /^my profile$/i }));

    await user.click(screen.getByText(/^edit profile$/i));
    const categoriesGroup = screen.getByRole("group", { name: /^categories$/i });
    expect(within(categoriesGroup).getByLabelText(/other \(optional\)/i)).toBeChecked();
    expect(within(categoriesGroup).getByLabelText(/other category 1/i)).toHaveValue("Protocol documentation");

    await user.click(screen.getByRole("button", { name: /save public profile/i }));
    const profileUpdateCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/bounties/profiles/me") && init?.method === "POST");
    expect(JSON.parse(String(profileUpdateCall?.[1]?.body))).toMatchObject({
      categories: ["Smart Contracts & Web3", "Protocol documentation"],
      customSpecialty: null
    });
  });

  it("falls back to the wallet address when a public profile has no ENS name", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("link", { name: /^profiles$/i }));

    await user.click(await screen.findByRole("button", { name: /view capital guide profile/i }));
    const walletIdentity = await screen.findByRole("link", { name: /view wallet on etherscan/i });
    expect(walletIdentity).toHaveAttribute("href", "https://etherscan.io/address/0x2222222222222222222222222222222222222222");
    expect(within(walletIdentity).getByText("0x2222…2222", { selector: "code" })).toBeInTheDocument();
    const profileCard = walletIdentity.closest(".profile-card") as HTMLElement;
    expect(within(profileCard).getAllByText("0x2222…2222", { selector: "code" })).toHaveLength(1);
    expect(walletIdentity.closest("h3")).toBeInTheDocument();
    const identityMeta = profileCard.querySelector(".profile-identity-meta") as HTMLElement;
    expect(within(identityMeta).getByRole("link", { name: /^website$/i })).toHaveAttribute("href", "https://example.test/profile");
    await user.click(within(profileCard).getByText(/report this profile/i));
    await user.selectOptions(within(profileCard).getByLabelText(/^concern$/i), "Illegal or prohibited activity");
    await user.type(within(profileCard).getByLabelText(/details.*optional/i), "Prohibited service promotion");
    await user.click(within(profileCard).getByRole("button", { name: /submit report/i }));
    expect(await screen.findByText(/report received/i)).toBeInTheDocument();
    const reportCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/api/bounties/reports"));
    expect(JSON.parse(String(reportCall?.[1]?.body))).toMatchObject({
      entityType: "profile",
      entityId: "00000000-0000-4000-8000-000000000222"
    });
  });

  it("publishes safe clickable links and privacy-conscious contact preferences", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await openCreatePage(user);
    await user.type(screen.getByLabelText(/bounty title/i), "Linked bounty");
    await user.type(screen.getByLabelText(/^description/i), "See https://example.com/spec for details.");
    await user.type(screen.getByLabelText(/contact alias/i), "build-team");
    await user.type(screen.getByLabelText(/resources provided/i), "Product brief");
    await user.type(screen.getByLabelText(/acceptance criteria/i), "Specification is satisfied");
    await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: /USDC.*USDC test token/i }));
    expect(screen.getByLabelText(/preferred contact method/i)).toHaveValue("Chirpy");
    await user.click(screen.getByRole("button", { name: /publish bounty/i }));

    const order = within((await screen.findByRole("heading", { name: /linked bounty/i })).closest("article") as HTMLElement);
    expect(order.getByRole("link", { name: /https:\/\/example\.com\/spec/i })).toHaveAttribute("href", "https://example.com/spec");
    expect(order.getByRole("link", { name: /chirpy/i })).toHaveAttribute("href", "https://chirpy.bittrees.org");
  });

  it("removes manual escrow verification and records the wallet transaction automatically", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    const order = await publishBounty(user, "Verify escrow observation");
    expect(order.queryByLabelText(/escrow transaction hash/i)).not.toBeInTheDocument();
    expect(order.queryByRole("button", { name: /verify escrow observation/i })).not.toBeInTheDocument();
    expect(order.queryByText(/API validates required confirmations, the receipt, and canonical create\/fund logs/i)).not.toBeInTheDocument();
  });

  it("fails closed on acceptance without an independently derivable approval commitment", async () => {
    configureMockMilestoneEscrow("BuyerApproved", "Approved");
    configureMockEscrowAddress("not-an-address");
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    const directoryCard = (await screen.findByRole("heading", { name: /two-phase active milestone/i })).closest("article") as HTMLElement;
    await user.click(within(directoryCard).getByRole("link", { name: /view bounty/i }));
    const order = within((await screen.findByRole("heading", { level: 2, name: /two-phase active milestone/i })).closest("article") as HTMLElement);

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
    }, {
      id: "00000000-0000-4000-8000-000000000890",
      entity_type: "token",
      entity_id: "00000000-0000-4000-8000-000000000003",
      entity_title: "BIT on network 84532",
      content: { type: "token", explorer_url: "https://sepolia.basescan.org/address/0x4444444444444444444444444444444444444444" },
      reason: "Suspected scam token",
      status: "open",
      version: 1,
      created_at: new Date().toISOString()
    }]);
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);
    await user.click(screen.getByRole("link", { name: /^moderator$/i }));
    expect(screen.getAllByRole("heading", { name: /moderator panel/i })).toHaveLength(2);
    expect(screen.getByText(/^Authorized moderator$/i)).toBeInTheDocument();
    expect(screen.getByText(/do not affect escrow, payment, or blockchain records/i)).toBeInTheDocument();
    expect(screen.getByText(/potentially illegal service/i)).toBeInTheDocument();
    expect(screen.getByText(/Profile report.*Profile 0x1111/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view reported profile/i })).toBeInTheDocument();
    expect(screen.getByText(/Token report.*BIT on network 84532/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /inspect reported token/i })).toHaveAttribute("href", expect.stringContaining("0x4444"));
    expect(screen.getAllByRole("option", { name: /keep visible.*no action/i })).toHaveLength(3);
    expect(screen.getAllByLabelText(/message to reporter/i)).toHaveLength(3);
  });
});
