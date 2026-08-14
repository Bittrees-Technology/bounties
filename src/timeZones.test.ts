import { describe, expect, it } from "vitest";
import { buildTimeZoneOptions, formatTimeZoneLabel, formatUtcOffset, timeZoneOffsetMinutes } from "./timeZones";

const winter = new Date("2026-01-15T12:00:00.000Z");

describe("timezone presentation", () => {
  it("formats whole-hour and fractional UTC offsets", () => {
    expect(formatUtcOffset(-300)).toBe("UTC-05:00");
    expect(formatUtcOffset(0)).toBe("UTC+00:00");
    expect(formatUtcOffset(330)).toBe("UTC+05:30");
  });

  it("uses the offset in effect on the selected date", () => {
    expect(timeZoneOffsetMinutes("America/New_York", winter)).toBe(-300);
    expect(timeZoneOffsetMinutes("UTC", winter)).toBe(0);
    expect(timeZoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(formatTimeZoneLabel("Asia/Kolkata", winter)).toBe("Asia/Kolkata (UTC+05:30)");
  });

  it("orders options by UTC offset and then timezone name", () => {
    expect(buildTimeZoneOptions([
      "Asia/Kolkata",
      "UTC",
      "America/New_York",
      "Africa/Abidjan"
    ], winter)).toEqual([
      { value: "America/New_York", label: "UTC-05:00 — America/New_York", offsetMinutes: -300 },
      { value: "Africa/Abidjan", label: "UTC+00:00 — Africa/Abidjan", offsetMinutes: 0 },
      { value: "UTC", label: "UTC+00:00 — UTC", offsetMinutes: 0 },
      { value: "Asia/Kolkata", label: "UTC+05:30 — Asia/Kolkata", offsetMinutes: 330 }
    ]);
  });
});
