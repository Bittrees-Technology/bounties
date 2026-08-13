import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { configureMockMilestoneEscrow, configureMockStaff } from "./test/setup";

afterEach(() => cleanup());

async function connectWallet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
  expect(await screen.findByRole("link", { name: /^my profile$/i })).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: /^marketplace$/i }));
  expect(await screen.findByRole("heading", { name: /how would you like to participate/i })).toBeInTheDocument();
  expect(window.sessionStorage.getItem("bounties.csrf")).toBe("csrf-test");
}

async function openCreatePage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("link", { name: /^create bounty$/i }));
  expect(screen.getByRole("heading", { name: /^create a bounty$/i })).toBeInTheDocument();
}

async function completeCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  tokenName: RegExp = /USDC test token.*USDC/i
) {
  await user.type(screen.getByLabelText(/bounty title/i), title);
  await user.type(screen.getByLabelText(/^description/i), "Marketplace");
  await user.type(screen.getByLabelText(/contact alias/i), "Marketplace Ops");
  await user.type(screen.getByLabelText(/resources provided/i), "Project brief and source files");
  await user.type(screen.getByLabelText(/acceptance criteria/i), "Delivery matches the approved scope");
  await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: tokenName }));
}

async function publishBounty(user: ReturnType<typeof userEvent.setup>, title = "Ship provider storefront", tokenName: RegExp = /USDC test token.*USDC/i) {
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
    expect(screen.getByRole("heading", { level: 1, name: /fund work.*deliver results/i })).toBeInTheDocument();
    expect(screen.getByText(/create or complete bounties with clear terms, milestones, and payment records/i)).toBeInTheDocument();
    expect(screen.getByText(/connecting a wallet proves ownership only.*never authorizes token spending/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^bounties$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/explore bounties, then sign in when you.re ready/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/won.t send a transaction or give bounties access to your tokens/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /how a bounty works/i })).toBeInTheDocument();
    expect(screen.getByText(/milestone clarity/i)).toBeInTheDocument();
    expect(screen.getByText(/role-specific reputation/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^browse bounties$/i })).toHaveAttribute("href", "/marketplace");
    expect(screen.getByRole("link", { name: /^marketplace$/i })).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^marketplace$/i })).toHaveAttribute("href", "/marketplace");
    expect(screen.getByRole("link", { name: /^create bounty$/i })).toHaveAttribute("href", "/create");

    await user.click(screen.getByRole("link", { name: /^browse bounties$/i }));
    expect(window.location.pathname).toBe("/marketplace");
    expect(screen.getByRole("heading", { level: 1, name: /work with clear terms and visible progress/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^marketplace$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^marketplace$/i })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("heading", { name: /how a bounty works/i })).not.toBeInTheDocument();
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
    const deliveryDate = screen.getByLabelText(/^delivery date$/i);
    await user.clear(deadline);
    await user.type(deadline, "2026-12-31");

    expect(deadline).toHaveValue("2026-12-31");
    expect(deliveryDate).toHaveValue("2026-12-31");
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

  it("routes the participation choices to hiring and work destinations", async () => {
    const user = userEvent.setup();
    render(<App />);
    await connectWallet(user);

    await user.click(screen.getByRole("button", { name: /i want to hire/i }));
    expect(await screen.findByRole("heading", { name: /^create a bounty$/i })).toBeInTheDocument();
    expect(await screen.findByText(/ready to create a bounty/i)).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /^marketplace$/i }));
    expect(screen.queryByText(/ready to create a bounty/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /i want to work/i }));
    expect(await screen.findByRole("heading", { name: /^marketplace$/i })).toBeInTheDocument();
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
    await completeCreateForm(user, "Exact decimal bounty", /WETH test token.*WETH/i);
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
    expect(screen.getByRole("option", { name: /WETH.*Wrapped Ether/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /USDC.*USD Coin/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^BIT · Base Sepolia · 0x4444.*4444$/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /BIT · BIT/i })).not.toBeInTheDocument();
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
    expect(screen.queryByText(/compare each participant.s marketplace history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ENS names are resolved from Ethereum/i)).not.toBeInTheDocument();
    const ownProfileButton = await screen.findByRole("button", { name: /view test participant profile/i });
    const ownDirectoryCard = ownProfileButton.closest(".profile-directory-card") as HTMLElement;
    expect(within(ownDirectoryCard).getByText(/public wallet profile/i)).toBeInTheDocument();
    expect(ownDirectoryCard.querySelector(".profile-hero")).toBeInTheDocument();
    expect(ownDirectoryCard.querySelector(".profile-identity-meta")).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/^you$/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByRole("link", { name: /view testparticipant\.eth on etherscan/i })).toHaveAttribute("href", "https://etherscan.io/address/0x1111111111111111111111111111111111111111");
    expect(within(ownDirectoryCard).getByRole("link", { name: /^website$/i })).toHaveAttribute("href", "https://example.test/profile");
    expect(within(ownDirectoryCard).queryByText("0x1111…1111")).not.toBeInTheDocument();
    const ownSpecialties = within(ownDirectoryCard).getByLabelText(/test participant specialties/i);
    expect(within(ownSpecialties).getByText(/defined task/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/consultation/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/ongoing retainer/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/smart contracts & web3/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/research & writing/i)).toBeInTheDocument();
    expect(within(ownSpecialties).getByText(/operations & support/i)).toBeInTheDocument();
    const directoryPreferenceGroups = ownSpecialties.querySelectorAll(".profile-specialty-group");
    expect(directoryPreferenceGroups).toHaveLength(2);
    expect(directoryPreferenceGroups[0]).toHaveAttribute("aria-label", "Work types");
    expect(directoryPreferenceGroups[1]).toHaveAttribute("aria-label", "Categories");
    const workTypeLink = within(ownSpecialties).getByRole("link", { name: /^defined task$/i });
    const categoryLink = within(ownSpecialties).getByRole("link", { name: /^smart contracts & web3$/i });
    expect(workTypeLink).toHaveAttribute("href", "/profiles?workType=task");
    expect(categoryLink).toHaveAttribute("href", "/profiles?category=Smart+Contracts+%26+Web3");
    expect(within(ownDirectoryCard).getByText(/^capital provider$/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/^labor provider$/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/5\.0 \/ 5 average · 3 ratings · 3 bounties worked/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).getByText(/3 bounties worked/i)).toBeInTheDocument();
    expect(within(ownDirectoryCard).queryByText(/total bounties posted or worked/i)).not.toBeInTheDocument();
    const otherProfileButton = screen.getByRole("button", { name: /view capital guide profile/i });
    const otherDirectoryCard = otherProfileButton.closest(".profile-directory-card") as HTMLElement;
    expect(otherDirectoryCard.querySelector(".profile-hero")).toBeInTheDocument();
    expect(otherDirectoryCard.querySelector(".profile-identity-meta")).toBeInTheDocument();
    expect(within(otherDirectoryCard).queryByText(/^you$/i)).not.toBeInTheDocument();
    expect(within(otherDirectoryCard).getByRole("link", { name: /view wallet on etherscan/i })).toHaveAttribute("href", "https://etherscan.io/address/0x2222222222222222222222222222222222222222");
    expect(within(otherDirectoryCard).getByText(/4\.8 \/ 5 average · 5 ratings · 2 bounties posted/i)).toBeInTheDocument();
    expect(within(otherDirectoryCard).getByText(/2 bounties posted/i)).toBeInTheDocument();
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
    const editControl = screen.getByText(/^edit profile$/i);
    const profileEditor = editControl.closest(".profile-editor") as HTMLElement;
    expect(profileEditor).toBeInTheDocument();
    const deactivateControl = within(profileEditor).getByText(/deactivate public profile/i);
    expect(deactivateControl.closest(".profile-visibility-control")).toBeInTheDocument();
    expect(profileEditor).not.toHaveAttribute("open");
    await user.click(editControl);
    expect(profileEditor).toHaveAttribute("open");
    await user.clear(screen.getByLabelText(/custom profile name/i));
    await user.type(screen.getByLabelText(/custom profile name/i), "Updated participant");
    await user.click(screen.getByLabelText(/defined task/i));
    await user.click(screen.getByLabelText(/software engineering/i));
    await user.type(screen.getByLabelText(/other specialty/i), "Protocol documentation");
    await user.click(screen.getByRole("button", { name: /save public profile/i }));
    expect(await screen.findByRole("heading", { name: /updated participant/i })).toBeInTheDocument();

    const profileUpdateCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/bounties/profiles/me") && init?.method === "POST");
    expect(JSON.parse(String(profileUpdateCall?.[1]?.body))).toMatchObject({
      workTypes: ["task"],
      categories: ["Software Engineering"],
      customSpecialty: "Protocol documentation"
    });

    await user.click(screen.getByText(/deactivate public profile/i));
    await user.click(screen.getByRole("button", { name: /hide my profile/i }));
    expect((await screen.findAllByText(/your public profile is hidden/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/profile details, ratings, reviews, and activity remain stored/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /test participant/i })).toBeInTheDocument();
    const hideCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith("/api/bounties/profiles/visibility") && init?.method === "POST");
    expect(JSON.parse(String(hideCall?.[1]?.body))).toEqual({ visible: false });

    await user.click(screen.getByRole("button", { name: /reactivate profile/i }));
    expect(await screen.findByText(/public profile is active again/i)).toBeInTheDocument();
    expect(screen.getByText(/deactivate public profile/i)).toBeInTheDocument();
    const visibilityCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/bounties/profiles/visibility"));
    expect(JSON.parse(String(visibilityCalls.at(-1)?.[1]?.body))).toEqual({ visible: true });

    const ratingContext = screen.getByText(/capital-provider and labor-provider ratings stay separate/i);
    expect(ratingContext.nextElementSibling).toHaveClass("profile-role-grid");

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
    await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: /USDC test token.*USDC/i }));
    expect(screen.getByLabelText(/preferred contact method/i)).toHaveValue("Chirpy");
    await user.click(screen.getByRole("button", { name: /publish bounty/i }));

    const order = within((await screen.findByRole("heading", { name: /linked bounty/i })).closest("article") as HTMLElement);
    expect(order.getByRole("link", { name: /https:\/\/example\.com\/spec/i })).toHaveAttribute("href", "https://example.com/spec");
    expect(order.getByRole("link", { name: /chirpy/i })).toHaveAttribute("href", "https://chirpy.bittrees.org");
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
    await user.click(screen.getByRole("link", { name: /^moderator$/i }));
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
