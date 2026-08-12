import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("enables participant escrow creation only when a deployment is configured", async () => {
  vi.stubEnv("VITE_ESCROW_ENABLED", "true");
  vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();

  render(<App />);
  await user.click(screen.getByRole("button", { name: /sign in with ethereum/i }));
  await screen.findByText(/roles are additive/i);
  await user.type(screen.getByLabelText(/request title/i), "Verify escrow observation");
  await user.type(screen.getByLabelText(/project/i), "Marketplace");
  await user.type(screen.getByLabelText(/buyer/i), "Marketplace Ops");
  await user.selectOptions(screen.getByLabelText(/^token$/i), screen.getByRole("option", { name: /USDC/i }));
  await user.click(screen.getByRole("button", { name: /publish bounty/i }));

  const order = within(await screen.findByRole("heading", { name: "Verify escrow observation" }).then((node) => node.closest("article") as HTMLElement));
  expect(order.getByRole("button", { name: /create and fund ERC20 escrow/i })).toBeInTheDocument();
  expect(order.getByRole("button", { name: /verify escrow observation/i })).toBeInTheDocument();
});
