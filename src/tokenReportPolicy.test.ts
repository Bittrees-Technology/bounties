import { describe, expect, it } from "vitest";
import {
  FREE_TOKEN_SAFETY_REASONS,
  PAID_TOKEN_REVIEW_REASON,
  tokenReportReasonIsAllowed
} from "./tokenReportPolicy";

describe("token report policy", () => {
  it("reserves the paid path for token and source verification", () => {
    expect(tokenReportReasonIsAllowed("review", PAID_TOKEN_REVIEW_REASON)).toBe(true);
    expect(tokenReportReasonIsAllowed("review", `${PAID_TOKEN_REVIEW_REASON}: inspect the proxy source`)).toBe(true);
    expect(tokenReportReasonIsAllowed("review", FREE_TOKEN_SAFETY_REASONS[0])).toBe(false);
  });

  it("keeps malicious-token flags on the free safety path", () => {
    for (const reason of FREE_TOKEN_SAFETY_REASONS) {
      expect(tokenReportReasonIsAllowed("safety_flag", reason)).toBe(true);
      expect(tokenReportReasonIsAllowed("safety_flag", `${reason}: supporting detail`)).toBe(true);
    }
    expect(tokenReportReasonIsAllowed("safety_flag", PAID_TOKEN_REVIEW_REASON)).toBe(false);
  });
});
