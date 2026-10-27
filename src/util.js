const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function cleanDomain(input = "") {
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  s = s.split("@").pop();
  s = s.replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
  return DOMAIN_RE.test(s) ? s : "";
}

export function looksLikeDomain(input = "") {
  const s = String(input).trim();
  if (!s || /\s/.test(s)) return false;
  return /\.[a-z]{2,63}(?:[/:?#].*)?$/i.test(s) && Boolean(cleanDomain(s));
}

const COMPANY_NOISE =
  /\b(inc|llc|llp|ltd|limited|pvt|private|corp|corporation|co|company|plc|gmbh|ag|sa|bv|nv|technologies|technology|labs|group|holdings|software|solutions|services|global|the)\b/g;

export function normalizeCompanyName(name = "") {
  return String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/\s+/g, "")
    .trim();
}

/** Loose match for "is this the same employer?" ("Infosys" vs "Infosys Limited"). */
export function sameCompany(a, b) {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

export function safeUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

export function linkedinUrl(value) {
  if (!value) return "";
  const s = String(value).trim();
  if (/^https?:\/\//i.test(s)) return safeUrl(s);
  if (/^(?:[a-z]+\.)?linkedin\.com\//i.test(s)) return safeUrl(`https://${s}`);
  return /^[\w-]{3,100}$/.test(s) ? `https://www.linkedin.com/in/${s}` : "";
}

// Deliberately stricter than RFC 5322: these values end up in mailto: links,
// where "?", "&", "%" or a second "@" could smuggle in extra recipients.
const EMAIL_RE = /^[A-Za-z0-9._+'-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value);
}

export function joinName(...parts) {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

export function initials(name = "") {
  const parts = String(name)
    .replace(/\*+/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}
