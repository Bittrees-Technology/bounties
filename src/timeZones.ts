export type TimeZoneOption = {
  value: string;
  label: string;
  offsetMinutes: number;
};

function offsetFromFormattedParts(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return Math.round((representedAsUtc - at.getTime()) / 60_000);
}

export function timeZoneOffsetMinutes(timeZone: string, at = new Date()): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  if (label === "GMT" || label === "UTC") return 0;
  const match = label?.match(/^(?:GMT|UTC)([+-])(\d{1,2}):?(\d{2})$/);
  if (!match) return offsetFromFormattedParts(timeZone, at);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60).toString().padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

export function formatTimeZoneLabel(timeZone: string, at = new Date()): string {
  return `${timeZone} (${formatUtcOffset(timeZoneOffsetMinutes(timeZone, at))})`;
}

export function buildTimeZoneOptions(timeZones: string[], at = new Date()): TimeZoneOption[] {
  const options: TimeZoneOption[] = [];
  for (const value of new Set(timeZones)) {
    try {
      const offsetMinutes = timeZoneOffsetMinutes(value, at);
      options.push({ value, offsetMinutes, label: `${formatUtcOffset(offsetMinutes)} — ${value}` });
    } catch {
      // Browser-provided timezone lists can differ between runtime versions.
    }
  }
  return options.sort((left, right) => left.offsetMinutes - right.offsetMinutes || left.value.localeCompare(right.value));
}
