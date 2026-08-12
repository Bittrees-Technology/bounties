import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { configureMockMilestoneEscrow } from "./test/setup";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function renderConfiguredEscrow() {
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /^connect wallet$/i }));
  await screen.findByText(/post bounties, provide services, or do both/i);
  return within((await screen.findByRole("heading", { name: /two-phase active milestone/i })).closest("article") as HTMLElement);
}

it("enables participant escrow creation only when a deployment is configured", async () => {
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();

  render(<App />);
  await user.click(screen.getAllByRole("button", { name: /^connect wallet$/i })[0]);
  await screen.findByText(/post bounties, provide services, or do both/i);
  await user.click(screen.getByRole("button", { name: /^create bounty$/i }));
  await user.type(screen.getByLabelText(/bounty title/i), "Verify escrow observation");
  await user.type(screen.getByLabelText(/project/i), "Marketplace");
  await user.type(screen.getByLabelText(/review contact/i), "Marketplace Ops");
  await user.selectOptions(screen.getByLabelText(/payment token/i), screen.getByRole("option", { name: /USDC/i }));
  await user.click(screen.getByRole("button", { name: /publish bounty/i }));

  const order = within(await screen.findByRole("heading", { name: "Verify escrow observation" }).then((node) => node.closest("article") as HTMLElement));
  expect(order.getByRole("button", { name: /create and fund ERC20 escrow/i })).toBeInTheDocument();
  expect(order.getByRole("button", { name: /verify escrow observation/i })).toBeInTheDocument();
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
  expect(order.getByRole("button", { name: /claim missed-deadline refund/i })).toBeInTheDocument();
});

it("requires wallet approval before offering offchain acceptance", async () => {
  configureMockMilestoneEscrow("Delivered", "Submitted");
  const order = await renderConfiguredEscrow();
  expect(order.queryByRole("button", { name: /accept completed work/i })).not.toBeInTheDocument();
  expect(order.getByRole("button", { name: /approve phase two onchain/i })).toBeInTheDocument();
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
