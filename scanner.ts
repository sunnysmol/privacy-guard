/**
 * PII / personal-data scanner.
 *
 * Returns a ScanResult describing whether personal data was found,
 * the confidence tier, and human-readable reasons.
 */

export interface ScanResult {
  hasPII: boolean;
  tier: "high" | "medium" | "none";
  reasons: string[];
  matches: string[];
}

// ── Tier 1: HIGH confidence — always redirect to local ────────────────────────
const HIGH_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "email address",    re: /\b[\w.+\-]+@[\w\-]+\.[a-z]{2,}\b/i },
  { label: "SSN",              re: /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/ },
  { label: "credit/debit card",re: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2})[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/ },
  { label: "private key",      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { label: "password literal", re: /\b(?:password|passwd|pwd)\s*[:=]\s*\S{4,}/i },
  { label: "API key/secret",   re: /\b(?:api[_\-]?key|api[_\-]?secret|access[_\-]?token|secret[_\-]?key)\s*[:=]\s*['"]?[\w\-]{16,}/i },
  { label: "AWS key",          re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "US phone number",  re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/ },
  { label: "IP address (private)", re: /\b(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/ },
];

// ── Tier 2: MEDIUM confidence — sensitive topics ───────────────────────────────
const MEDIUM_KEYWORDS: Array<{ label: string; re: RegExp }> = [
  { label: "address/location",   re: /\bmy (?:home |current )?address\b|\b\d{1,5}\s[\w\s]{2,30}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|blvd)\b/i },
  { label: "date of birth",      re: /\b(?:date of birth|dob|born on|birthday)\b/i },
  { label: "passport/national ID",re: /\b(?:passport|national id|driving licen[sc]e|driver.s licen[sc]e)\b/i },
  { label: "medical/health",     re: /\b(?:medical record|diagnosis|prescription|my doctor|my medication|my condition|health insurance)\b/i },
  { label: "financial",          re: /\b(?:bank account|routing number|iban|swift code|my salary|my income|tax return|my ssn|my pin)\b/i },
  { label: "login credentials",  re: /\b(?:my username|my login|my credentials|sign.?in details)\b/i },
  { label: "biometric",          re: /\b(?:fingerprint|face id|touch id|biometric)\b/i },
];

export function scanForPII(text: string): ScanResult {
  const reasons: string[] = [];
  const matches: string[] = [];

  // Check HIGH tier
  for (const { label, re } of HIGH_PATTERNS) {
    const m = text.match(re);
    if (m) {
      reasons.push(label);
      matches.push(m[0].slice(0, 30)); // truncate for display
    }
  }

  if (reasons.length > 0) {
    return { hasPII: true, tier: "high", reasons, matches };
  }

  // Check MEDIUM tier
  for (const { label, re } of MEDIUM_KEYWORDS) {
    const m = text.match(re);
    if (m) {
      reasons.push(label);
      matches.push(m[0].slice(0, 30));
    }
  }

  if (reasons.length > 0) {
    return { hasPII: true, tier: "medium", reasons, matches };
  }

  return { hasPII: false, tier: "none", reasons: [], matches: [] };
}
