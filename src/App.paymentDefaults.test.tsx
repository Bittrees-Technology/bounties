import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("starts bounty payments on Ethereum and offers verified presets on each mainnet", async () => {
  vi.stubEnv("VITE_DEFAULT_PAYMENT_CHAIN_ID", "1");
  vi.resetModules();
  const { default: App } = await import("./App");
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("link", { name: /^create bounty$/i }));

  const network = screen.getByLabelText(/payment network/i);
  const paymentToken = screen.getByLabelText(/payment token/i);
  expect(network).toHaveValue("1");
  expect(within(paymentToken).getByRole("option", { name: /WETH.*Wrapped Ether/i })).toBeInTheDocument();
  expect(within(paymentToken).getByRole("option", { name: /WBTC.*Wrapped Bitcoin/i })).toBeInTheDocument();
  expect(within(paymentToken).getByRole("option", { name: /USDC.*USD Coin/i })).toBeInTheDocument();
  expect(within(paymentToken).getByRole("option", { name: /USDT.*Tether USD/i })).toBeInTheDocument();

  await user.selectOptions(network, "8453");
  expect(within(paymentToken).getByRole("option", { name: /WETH.*Wrapped Ether/i })).toBeInTheDocument();
  expect(within(paymentToken).getByRole("option", { name: /USDC.*USD Coin/i })).toBeInTheDocument();

  await user.selectOptions(network, "4663");
  expect(within(paymentToken).getByRole("option", { name: /WETH.*Wrapped Ether/i })).toBeInTheDocument();
  expect(within(paymentToken).getByRole("option", { name: /USDG.*Global Dollar/i })).toBeInTheDocument();
});
