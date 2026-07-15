import { describe, expect, it } from "vitest";
import { createBounty, isDraftValid, parseCriteria, parseSupport } from "./bountyModel";

describe("bounty model", () => {
  it("parses multiline support and acceptance criteria", () => {
    expect(parseSupport("Docs\n\nReviewer")).toEqual(["Docs", "Reviewer"]);
    expect(parseCriteria("Merged PR\nEvidence attached")).toEqual([
      { id: "draft-1", label: "Merged PR", required: true },
      { id: "draft-2", label: "Evidence attached", required: true },
    ]);
  });

  it("requires support and acceptance criteria before staging a bounty", () => {
    expect(isDraftValid({
      title: "Build page",
      scope: "task",
      project: "Bounties",
      reward: 100,
      token: "USDC",
      creator: "Ops",
      support: "",
      criteria: "Accepted by reviewer",
    })).toBe(false);
  });

  it("creates a ready-to-escrow bounty from a valid draft", () => {
    const bounty = createBounty({
      title: "Build page",
      scope: "project",
      project: "Bounties",
      reward: 500,
      token: "USDC",
      creator: "Ops",
      support: "Spec",
      criteria: "Accepted by reviewer",
    }, 9);

    expect(bounty.id).toBe("bt-010");
    expect(bounty.escrowStatus).toBe("ready");
    expect(bounty.criteria).toHaveLength(1);
  });
});
