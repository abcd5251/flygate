import type { Cabin, Mandate, PassengerInput, Place } from "./types";

export const PLACES: Record<string, Place> = {
  TPE: { code: "TPE", city: "Taipei", airportName: "Taoyuan International", airports: ["TPE"] },
  TYO: { code: "TYO", city: "Tokyo", airportName: "All airports", airports: ["NRT", "HND"] },
  OSA: { code: "OSA", city: "Osaka", airportName: "All airports", airports: ["KIX", "ITM"] },
  SEL: { code: "SEL", city: "Seoul", airportName: "All airports", airports: ["ICN", "GMP"] },
  BKK: { code: "BKK", city: "Bangkok", airportName: "All airports", airports: ["BKK", "DMK"] },
  CNX: { code: "CNX", city: "Chiang Mai", airportName: "Chiang Mai International", airports: ["CNX"] },
  HKG: { code: "HKG", city: "Hong Kong", airportName: "Hong Kong International", airports: ["HKG"] },
  SIN: { code: "SIN", city: "Singapore", airportName: "Changi", airports: ["SIN"] },
};

const CITY_ALIASES: Array<[RegExp, string]> = [
  [/台北|臺北|桃園|taipei|tpe/i, "TPE"],
  [/東京|tokyo|成田|羽田|narita|haneda|nrt|hnd/i, "TYO"],
  [/大阪|osaka|關西|kansai|kix/i, "OSA"],
  [/首爾|seoul|仁川|incheon|icn/i, "SEL"],
  [/曼谷|bangkok|bkk/i, "BKK"],
  [/清邁|chiang ?mai|cnx/i, "CNX"],
  [/香港|hong ?kong|hkg/i, "HKG"],
  [/新加坡|singapore|\bsin\b/i, "SIN"],
];

export const CABIN_LABEL: Record<Cabin, string> = {
  economy: "Economy",
  premium: "Premium economy",
  business: "Business",
};

export const DEMO_YEAR = 2026;
export const USD_TO_TWD = 32;

export function defaultMandate(): Mandate {
  return {
    origin: PLACES.TPE,
    destination: PLACES.TYO,
    departFrom: "2026-12-20",
    departTo: "2026-12-22",
    cabin: "economy",
    refundableOnly: true,
    directOnly: false,
    maxFareUsd: 400,
    maxTickets: 1,
    passengers: 1,
    expiresAt: "2026-12-19T23:59:00+08:00",
  };
}

export function defaultPassenger(): PassengerInput {
  return { surname: "CHEN", givenName: "MEI", passportNo: "312345678", nationality: "TWN" };
}

export const EXAMPLE_INTENT = "Taipei to Tokyo, Dec 20, economy, refundable, max $400";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function findCity(text: string): string | undefined {
  for (const [re, code] of CITY_ALIASES) if (re.test(text)) return code;
  return undefined;
}

export type ParsedIntent = {
  patch: Partial<Mandate>;
  chips: string[];
};

/**
 * Small deterministic parser for the demo (English or Chinese). In the full build
 * Claude turns free text into this same structure, and this stays as the fallback.
 */
export function parseIntent(text: string): ParsedIntent {
  const patch: Partial<Mandate> = {};
  const chips: string[] = [];
  const t = text.replace(/\s+/g, " ");

  const routePatterns = [
    /(?:from\s+)?([a-z][a-z ]{1,20}?)\s+(?:to|→|->)\s+([a-z][a-z ]{1,20}?)(?=[,.;\s]|$)/gi,
    /(?:從)?\s*([^\s，,。\d/]{2,8}?)\s*(?:飛|到|→|->|去)\s*([^\s，,。\d/]{2,8})/g,
  ];
  outer: for (const re of routePatterns) {
    for (const route of t.matchAll(re)) {
      const from = findCity(route[1]);
      const to = findCity(route[2]);
      if (!from && !to) continue;
      if (from) {
        patch.origin = PLACES[from];
        chips.push(`From ${PLACES[from].city}`);
      }
      if (to) {
        patch.destination = PLACES[to];
        chips.push(`To ${PLACES[to].city}`);
      }
      break outer;
    }
  }

  let from: { m: number; d: number } | undefined;
  let to: { m: number; d: number } | undefined;
  const named = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:\s*(?:-|–|to)\s*(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*)?(\d{1,2}))?/i);
  const numeric = t.match(/(\d{1,2})\/(\d{1,2})(?:\s*(?:-|–|~|to|到|至)\s*(?:(\d{1,2})\/)?(\d{1,2}))?/);
  if (named) {
    const m1 = MONTHS.indexOf(named[1].toLowerCase()) + 1;
    from = { m: m1, d: Number(named[2]) };
    if (named[4]) to = { m: named[3] ? MONTHS.indexOf(named[3].toLowerCase()) + 1 : m1, d: Number(named[4]) };
  } else if (numeric) {
    from = { m: Number(numeric[1]), d: Number(numeric[2]) };
    if (numeric[4]) to = { m: numeric[3] ? Number(numeric[3]) : from.m, d: Number(numeric[4]) };
  }
  if (from) {
    patch.departFrom = `${DEMO_YEAR}-${pad(from.m)}-${pad(from.d)}`;
    patch.departTo = to ? `${DEMO_YEAR}-${pad(to.m)}-${pad(to.d)}` : addDays(patch.departFrom, 2);
    patch.expiresAt = `${addDays(patch.departFrom, -1)}T23:59:00+08:00`;
    chips.push(formatRange(patch.departFrom, patch.departTo));
  }

  if (/business|商務艙/i.test(t)) {
    patch.cabin = "business";
    chips.push("Business");
  } else if (/premium|豪華經濟/i.test(t)) {
    patch.cabin = "premium";
    chips.push("Premium economy");
  } else if (/economy|經濟艙/i.test(t)) {
    patch.cabin = "economy";
    chips.push("Economy");
  }

  if (/non-?refundable|不用可退|不可退也可以/i.test(t)) {
    patch.refundableOnly = false;
    chips.push("Any fare type");
  } else if (/refundable|可退/i.test(t)) {
    patch.refundableOnly = true;
    chips.push("Refundable only");
  }

  if (/non-?stop|direct|直飛/i.test(t)) {
    patch.directOnly = true;
    chips.push("Nonstop only");
  }

  const price = t.match(/(?:max|under|up to|budget|no more than|最多|不超過|上限|預算|最高)\s*(?:of\s*)?(?:US\$|USD|\$|NT\$|台幣)?\s*([\d,]+)\s*(usd|dollars|美金|美元|台幣|元|TWD)?/i);
  if (price) {
    let value = Number(price[1].replace(/,/g, ""));
    const unit = price[2] ?? "";
    if (/台幣|元|TWD/i.test(unit) || /NT\$|台幣/.test(price[0])) value = Math.round(value / USD_TO_TWD);
    if (value > 0) {
      patch.maxFareUsd = value;
      chips.push(`Max US$${value}`);
    }
  }

  return { patch, chips };
}

export function formatDateLong(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTH_LABEL[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatShortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${MONTH_LABEL[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function formatRange(fromIso: string, toIso: string) {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  if (a.getUTCMonth() === b.getUTCMonth()) return `${MONTH_LABEL[a.getUTCMonth()]} ${a.getUTCDate()}–${b.getUTCDate()}`;
  return `${formatShortDate(fromIso)}–${formatShortDate(toIso)}`;
}

/** Expiry shown in Taipei time (UTC+8). */
export function formatExpiry(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  return `${MONTH_LABEL[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function usd(n: number) {
  return `US$${n.toLocaleString("en-US")}`;
}

export type RuleRow = {
  key: string;
  says: string;
  mechanism: string;
  blocks: string;
};

/** How the user's request maps onto chain-enforced limits. */
export function mandateRules(m: Mandate): RuleRow[] {
  return [
    { key: "perTx", says: `Max ${usd(m.maxFareUsd)}`, mechanism: "Spending rule · perTxLimit", blocks: "Overpriced tickets" },
    { key: "budget", says: `${m.maxTickets} ticket`, mechanism: "Spending rule · dailyLimit", blocks: "Buying twice" },
    { key: "target", says: "Pay escrow only", mechanism: "Scoped window · allowedTargets", blocks: "Sending funds elsewhere" },
    { key: "expiry", says: `Expires ${formatExpiry(m.expiresAt)}`, mechanism: "Agent key · expiryUnix", blocks: "Spending after expiry" },
    { key: "maxTx", says: "One transaction", mechanism: "Scoped window · maxTxs", blocks: "Duplicate orders" },
    { key: "quote", says: "Signed quotes only", mechanism: "ML-DSA-87 + pqcVerify", blocks: "Fake or edited prices" },
  ];
}

/** Stable JSON so the mandate hash is reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
