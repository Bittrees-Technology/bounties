import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("marketplace directory responsive boundaries", () => {
  const styles = readFileSync("src/styles.css", "utf8");

  it("uses the marketplace panel width before placing all filters on one row", () => {
    expect(styles).toMatch(/\.marketplace-page\s*\{[^}]*container-name:\s*marketplace-directory;[^}]*container-type:\s*inline-size;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.bounty-directory-filters\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/@container marketplace-directory \(min-width:\s*1080px\)[\s\S]*\.bounty-directory-filters\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*1\.2fr\)\s*repeat\(4,\s*minmax\(135px,\s*1fr\)\)\s*minmax\(188px,\s*1\.15fr\);/s);
  });

  it("bounds filter controls and bounty results to the panel", () => {
    expect(styles).toMatch(/\.bounty-directory-filters :is\(input, select\)\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*width:\s*100%;/s);
    expect(styles).toMatch(/\.bounty-directory-grid\s*\{[^}]*display:\s*grid;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
  });
});
