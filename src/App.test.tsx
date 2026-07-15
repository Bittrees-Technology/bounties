import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("stages a new bounty with support and acceptance criteria", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/title/i), "Ship Bittrees payout view");
    await user.type(screen.getByLabelText(/project/i), "Bounties");
    await user.type(screen.getByLabelText(/creator/i), "Engineering");
    await user.click(screen.getByRole("button", { name: /stage bounty/i }));

    expect(screen.getByText("Ship Bittrees payout view")).toBeInTheDocument();
    expect(screen.getAllByText(/Ready to escrow/i).length).toBeGreaterThanOrEqual(1);
  });
});
