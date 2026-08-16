export const PAID_TOKEN_REVIEW_REASON = "Token/source verification review";

export const FREE_TOKEN_SAFETY_REASONS = [
  "Suspected malicious token or contract",
  "Impersonation or misleading metadata",
  "Malicious transfer behavior",
  "Other token safety concern"
] as const;

export type TokenReportAction = "review" | "safety_flag";

function beginsWithReason(reason: string, allowed: string): boolean {
  return reason === allowed || reason.startsWith(`${allowed}: `);
}

export function tokenReportReasonIsAllowed(action: TokenReportAction, reason: string): boolean {
  return action === "review"
    ? beginsWithReason(reason, PAID_TOKEN_REVIEW_REASON)
    : FREE_TOKEN_SAFETY_REASONS.some((allowed) => beginsWithReason(reason, allowed));
}
