import { describe, expect, it } from "vitest";
import type { PublicWalletProfile } from "./persistence/supabase";
import { orderAndFilterProfiles } from "./profileDirectory";

function profile(overrides: Partial<PublicWalletProfile> & Pick<PublicWalletProfile, "account_id" | "wallet_address">): PublicWalletProfile {
  return {
    display_name: null,
    profile_bio: null,
    profile_url: null,
    profile_moderation_status: "visible",
    profile_updated_at: "2026-08-13T12:00:00.000Z",
    member_since: "2026-01-01T00:00:00.000Z",
    roles: [],
    activity_summary: { capital_bounties: 0, labor_bounties: 0 },
    rating_summaries: {
      capital_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      labor_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }
    },
    reviews_received: [],
    ...overrides
  };
}

const profiles = [
  profile({ account_id: "wallet", wallet_address: "0xffffffffffffffffffffffffffffffffffffffff" }),
  profile({ account_id: "zebra", wallet_address: "0x3333333333333333333333333333333333333333", display_name: "Zebra", last_completed_activity_at: "2026-08-12T12:00:00.000Z" }),
  profile({ account_id: "ens", wallet_address: "0x2222222222222222222222222222222222222222", ens_name: "alice.eth", last_completed_activity_at: "2026-07-01T12:00:00.000Z" }),
  profile({ account_id: "beta", wallet_address: "0x1111111111111111111111111111111111111111", display_name: "Beta", last_completed_activity_at: "2025-01-01T12:00:00.000Z" })
];

describe("profile directory ordering", () => {
  it("sorts named and ENS profiles A-Z before wallet-only profiles", () => {
    expect(orderAndFilterProfiles(profiles, "name-asc", "any").map((item) => item.account_id)).toEqual(["ens", "beta", "zebra", "wallet"]);
  });

  it("sorts named and ENS profiles Z-A while keeping wallet-only profiles last", () => {
    expect(orderAndFilterProfiles(profiles, "name-desc", "any").map((item) => item.account_id)).toEqual(["zebra", "beta", "ens", "wallet"]);
  });

  it("orders recent completed activity and keeps accounts without completions last", () => {
    expect(orderAndFilterProfiles(profiles, "recent-activity", "any").map((item) => item.account_id)).toEqual(["zebra", "ens", "beta", "wallet"]);
  });

  it("filters by completed activity windows and supports accounts without completed activity", () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    expect(orderAndFilterProfiles(profiles, "name-asc", "30-days", now).map((item) => item.account_id)).toEqual(["zebra"]);
    expect(orderAndFilterProfiles(profiles, "name-asc", "90-days", now).map((item) => item.account_id)).toEqual(["ens", "zebra"]);
    expect(orderAndFilterProfiles(profiles, "name-asc", "no-completed-activity", now).map((item) => item.account_id)).toEqual(["wallet"]);
  });
});
