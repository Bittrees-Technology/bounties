import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("create bounty responsive boundaries", () => {
  const styles = readFileSync("src/styles.css", "utf8");

  it("gives token review text enough room and keeps its action inside the card", () => {
    expect(styles).toMatch(/\.selected-token-card \.report-control\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*width:\s*100%;/s);
    expect(styles).toMatch(/\.selected-token-card \.report-control form\s*\{[^}]*grid-template-columns:\s*minmax\(260px,\s*\.8fr\)\s*minmax\(0,\s*1\.2fr\);/s);
    expect(styles).toMatch(/\.selected-token-card \.report-control form button\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;/s);
  });

  it("bounds every milestone control and removes the unused action column", () => {
    expect(styles).toMatch(/\.milestone-input-row\s*\{[^}]*grid-template-columns:\s*auto\s*minmax\(0,\s*1\.2fr\)\s*minmax\(100px,\s*\.5fr\)\s*minmax\(210px,\s*\.8fr\);[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.milestone-input-row label,[^{]*\.milestone-input-row input\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*\.milestone-input-row--removable\s*\{\s*grid-template-columns:\s*auto\s*minmax\(0,\s*1fr\);\s*\}/);
  });
});
