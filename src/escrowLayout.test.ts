import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("escrow and review responsive boundaries", () => {
  const styles = readFileSync("src/styles.css", "utf8");

  it("keeps transaction status in a wrapping bounded block", () => {
    expect(styles).toMatch(/\.escrow-transaction-link\s*\{[^}]*display:\s*block;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.escrow-transaction-link a,[^{]*\{[^}]*flex-wrap:\s*wrap;[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;/s);
  });

  it("isolates lifecycle controls and stacks their action on mobile", () => {
    expect(styles).toMatch(/\.escrow-lifecycle-controls\s*\{[^}]*display:\s*grid;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*\.escrow-lifecycle-controls > button\s*\{\s*width:\s*100%;\s*\}/);
  });

  it("bounds the reviews panel and each review row", () => {
    expect(styles).toMatch(/\.review-panel\s*\{[^}]*clear:\s*both;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.review-row > div,[^{]*\.review-actions\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
  });

  it("bounds the terminal settlement record and stacks proof metadata on mobile", () => {
    expect(styles).toMatch(/\.settlement-completed-record\s*\{[^}]*display:\s*grid;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.settlement-terminal-meta\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.settlement-receipt-link\s*\{[^}]*flex-wrap:\s*wrap;[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;/s);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*\.settlement-terminal-meta\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}/);
  });
});
