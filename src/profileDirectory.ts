import type { PublicWalletProfile } from "./persistence/supabase";

export type ProfileDirectoryOrder = "name-asc" | "name-desc" | "recent-activity";
export type ProfileActivityWindow = "any" | "30-days" | "90-days" | "1-year" | "no-completed-activity";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const dayMs = 24 * 60 * 60 * 1_000;

function hasNamedIdentity(profile: PublicWalletProfile): boolean {
  return Boolean(profile.display_name?.trim() || profile.ens_name?.trim());
}

function identityKey(profile: PublicWalletProfile): string {
  return profile.display_name?.trim() || profile.ens_name?.trim() || profile.wallet_address;
}

function completedActivityTime(profile: PublicWalletProfile): number | null {
  if (!profile.last_completed_activity_at) return null;
  const timestamp = Date.parse(profile.last_completed_activity_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function orderAndFilterProfiles(
  profiles: PublicWalletProfile[],
  order: ProfileDirectoryOrder,
  activityWindow: ProfileActivityWindow,
  now = Date.now()
): PublicWalletProfile[] {
  const windowDays = activityWindow === "30-days" ? 30 : activityWindow === "90-days" ? 90 : activityWindow === "1-year" ? 365 : null;
  const filtered = profiles.filter((profile) => {
    const completedAt = completedActivityTime(profile);
    if (activityWindow === "no-completed-activity") return completedAt === null;
    if (windowDays === null) return true;
    return completedAt !== null && completedAt >= now - windowDays * dayMs && completedAt <= now;
  });

  return [...filtered].sort((left, right) => {
    const leftNamed = hasNamedIdentity(left);
    const rightNamed = hasNamedIdentity(right);

    if (order !== "recent-activity" && leftNamed !== rightNamed) return leftNamed ? -1 : 1;

    if (order === "recent-activity") {
      const leftActivity = completedActivityTime(left);
      const rightActivity = completedActivityTime(right);
      if (leftActivity !== rightActivity) {
        if (leftActivity === null) return 1;
        if (rightActivity === null) return -1;
        return rightActivity - leftActivity;
      }
      if (leftNamed !== rightNamed) return leftNamed ? -1 : 1;
    }

    const comparison = collator.compare(identityKey(left), identityKey(right));
    if (comparison !== 0) return order === "name-desc" ? -comparison : comparison;
    return collator.compare(left.wallet_address, right.wallet_address);
  });
}

export function profileLastCompletedLabel(profile: PublicWalletProfile): string {
  const timestamp = completedActivityTime(profile);
  if (timestamp === null) return "No completed activity";
  return `Last completed ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp)}`;
}
