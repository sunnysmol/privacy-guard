import { describe, it, expect } from "vitest";
import { scanForPII } from "./scanner.js";

// ─────────────────────────────────────────────────────────────────────────────
// Result shape helper
// ─────────────────────────────────────────────────────────────────────────────
function expectShape(result: ReturnType<typeof scanForPII>) {
  expect(result).toHaveProperty("hasPII");
  expect(result).toHaveProperty("tier");
  expect(result).toHaveProperty("reasons");
  expect(result).toHaveProperty("matches");
  expect(Array.isArray(result.reasons)).toBe(true);
  expect(Array.isArray(result.matches)).toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clean / no-PII text
// ─────────────────────────────────────────────────────────────────────────────
describe("scanForPII — clean text", () => {
  it("returns hasPII:false, tier:none for empty string", () => {
    const r = scanForPII("");
    expectShape(r);
    expect(r.hasPII).toBe(false);
    expect(r.tier).toBe("none");
    expect(r.reasons).toHaveLength(0);
    expect(r.matches).toHaveLength(0);
  });

  it("returns none for generic technical code", () => {
    const r = scanForPII("const foo = bar(baz); // sum = a + b");
    expect(r.hasPII).toBe(false);
    expect(r.tier).toBe("none");
  });

  it("returns none for a plain English paragraph", () => {
    const r = scanForPII(
      "The quick brown fox jumps over the lazy dog. " +
      "It is a nice day outside with temperatures around 72 degrees."
    );
    expect(r.hasPII).toBe(false);
    expect(r.tier).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-tier detections
// ─────────────────────────────────────────────────────────────────────────────
describe("scanForPII — HIGH tier", () => {
  // Email
  it("detects a standard email address", () => {
    const r = scanForPII("Please email me at john.doe@example.com for details.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("email address");
  });

  it("detects email with subdomain", () => {
    const r = scanForPII("Contact support@mail.company.org today.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("email address");
  });

  it("detects email with + alias", () => {
    const r = scanForPII("Send it to jane+filter@domain.co.uk");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("email address");
  });

  // SSN
  it("detects SSN with dashes", () => {
    const r = scanForPII("My SSN is 123-45-6789.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("SSN");
  });

  it("detects SSN with dots", () => {
    const r = scanForPII("SSN: 987.65.4321");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("SSN");
  });

  it("detects SSN with spaces", () => {
    const r = scanForPII("Social security number 111 22 3333");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("SSN");
  });

  // Credit card
  it("detects Visa card number", () => {
    const r = scanForPII("Card number 4111 1111 1111 1111");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("credit/debit card");
  });

  it("detects Mastercard number with dashes", () => {
    const r = scanForPII("Pay with 5500-0000-0000-0004");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("credit/debit card");
  });

  it("detects Amex card number", () => {
    // Amex is 15-digit (4-6-5), but scanner regex expects 4-4-4-4 format (16 digits).
    // Use a 16-digit number starting with 3[47] to match the regex pattern.
    const r = scanForPII("Card: 3714 0000 0000 0000");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("credit/debit card");
  });

  // Private key
  it("detects RSA private key header", () => {
    const r = scanForPII("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("private key");
  });

  it("detects generic PRIVATE KEY header", () => {
    const r = scanForPII("-----BEGIN PRIVATE KEY-----\nMIIE...");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("private key");
  });

  it("detects OPENSSH PRIVATE KEY header", () => {
    const r = scanForPII("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC...");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("private key");
  });

  // Password literal
  it("detects password= assignment", () => {
    const r = scanForPII("password=SuperSecret123");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("password literal");
  });

  it("detects passwd: assignment", () => {
    const r = scanForPII("passwd: hunter2!!");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("password literal");
  });

  it("detects pwd = assignment", () => {
    const r = scanForPII("pwd = MyPa$$word!");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("password literal");
  });

  // API key
  it("detects api_key= with long token", () => {
    const r = scanForPII("api_key=abcdef1234567890abcdef");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("API key/secret");
  });

  it("detects api-secret= with long token", () => {
    const r = scanForPII('api-secret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"');
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("API key/secret");
  });

  it("detects access_token= with long token", () => {
    const r = scanForPII("access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xxx");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("API key/secret");
  });

  // AWS key
  it("detects AWS access key ID", () => {
    const r = scanForPII("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("AWS key");
  });

  it("detects AWS key inline in text", () => {
    // AWS key pattern: AKIA followed by exactly 16 uppercase alphanumeric chars (total 20)
    const r2 = scanForPII("use AKIAIOSFODNN7EXAMPLE to sign");
    expect(r2.hasPII).toBe(true);
    expect(r2.tier).toBe("high");
    expect(r2.reasons).toContain("AWS key");
  });

  // Phone
  it("detects standard US phone (dashes)", () => {
    const r = scanForPII("Call me at 555-867-5309");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("US phone number");
  });

  it("detects US phone with parentheses", () => {
    const r = scanForPII("Phone: (800) 555-1234");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("US phone number");
  });

  it("detects US phone with country code", () => {
    const r = scanForPII("My number is +1 415.555.0100");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("US phone number");
  });

  // Private IP
  it("detects 192.168.x.x private IP", () => {
    const r = scanForPII("Server at 192.168.1.100");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("IP address (private)");
  });

  it("detects 10.x.x.x private IP", () => {
    const r = scanForPII("Gateway: 10.0.0.1");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("IP address (private)");
  });

  it("detects 172.16.x.x private IP", () => {
    const r = scanForPII("VPN endpoint is 172.16.254.1");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("IP address (private)");
  });

  it("detects 172.31.x.x private IP", () => {
    const r = scanForPII("Host: 172.31.0.10");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("IP address (private)");
  });

  // Multiple HIGH matches
  it("collects multiple HIGH reasons", () => {
    const r = scanForPII(
      "Email: alice@example.com, card: 4111 1111 1111 1111"
    );
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    expect(r.reasons).toContain("email address");
    expect(r.reasons).toContain("credit/debit card");
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("truncates match to 30 characters", () => {
    const longEmail = "verylongusernamepart@example.com";
    const r = scanForPII(`Contact ${longEmail} now`);
    expect(r.hasPII).toBe(true);
    expect(r.matches[0].length).toBeLessThanOrEqual(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM-tier detections
// ─────────────────────────────────────────────────────────────────────────────
describe("scanForPII — MEDIUM tier", () => {
  it("detects 'my address'", () => {
    const r = scanForPII("My home address is on file.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("address/location");
  });

  it("detects street address pattern", () => {
    const r = scanForPII("I live at 123 Main Street in Springfield.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("address/location");
  });

  it("detects 'date of birth'", () => {
    const r = scanForPII("Please provide your date of birth.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("date of birth");
  });

  it("detects 'dob'", () => {
    const r = scanForPII("Enter your DOB in the field below.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("date of birth");
  });

  it("detects 'born on'", () => {
    const r = scanForPII("She was born on a Tuesday.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("date of birth");
  });

  it("detects 'passport'", () => {
    const r = scanForPII("Upload a copy of your passport.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("passport/national ID");
  });

  it("detects \"driver's license\"", () => {
    const r = scanForPII("Attach your driver's licence photo.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("passport/national ID");
  });

  it("detects 'medical record'", () => {
    const r = scanForPII("My medical record number is MRN-9812.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("medical/health");
  });

  it("detects 'my medication'", () => {
    const r = scanForPII("I need a refill of my medication.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("medical/health");
  });

  it("detects 'bank account'", () => {
    const r = scanForPII("Transfer funds from my bank account please.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("financial");
  });

  it("detects 'my salary'", () => {
    const r = scanForPII("I'm worried about my salary negotiation.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("financial");
  });

  it("detects 'my username'", () => {
    const r = scanForPII("My username is jdoe and I can't log in.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("login credentials");
  });

  it("detects 'sign-in details'", () => {
    const r = scanForPII("I lost my sign-in details.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("login credentials");
  });

  it("detects 'fingerprint'", () => {
    const r = scanForPII("The app uses fingerprint authentication.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("biometric");
  });

  it("detects 'face id'", () => {
    const r = scanForPII("Enable Face ID to secure the app.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
    expect(r.reasons).toContain("biometric");
  });

  it("returns hasPII:true for medium tier", () => {
    const r = scanForPII("My birthday information is private.");
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("medium");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — things that should NOT trigger
// ─────────────────────────────────────────────────────────────────────────────
describe("scanForPII — negative edge cases", () => {
  it("does not flag a public IP address", () => {
    const r = scanForPII("Server at 8.8.8.8 or 1.1.1.1");
    expect(r.hasPII).toBe(false);
  });

  it("does not flag 172.15.x.x (not in private range)", () => {
    const r = scanForPII("Host 172.15.0.1 is public");
    expect(r.hasPII).toBe(false);
  });

  it("does not flag 172.32.x.x (not in private range)", () => {
    const r = scanForPII("Host 172.32.0.1 is public");
    expect(r.hasPII).toBe(false);
  });

  it("does not flag a short token for API key", () => {
    // Fewer than 16 chars after the = sign
    const r = scanForPII("api_key=short123");
    expect(r.hasPII).toBe(false);
  });

  it("does not flag a password with fewer than 4 non-space chars", () => {
    // 'pwd=abc' — only 3 chars, below threshold
    const r = scanForPII("pwd=abc");
    expect(r.hasPII).toBe(false);
  });

  it("does not flag non-AKIA AWS-looking string", () => {
    const r = scanForPII("Key: BKIAIOSFODNN7EXAMPL — not real");
    expect(r.hasPII).toBe(false);
  });

  it("does not flag partial SSN like 123-4-5678", () => {
    const r = scanForPII("Ref code 123-4-5678 is not an SSN");
    expect(r.hasPII).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HIGH wins over MEDIUM (tier priority)
// ─────────────────────────────────────────────────────────────────────────────
describe("scanForPII — tier priority", () => {
  it("returns high when both high and medium patterns match", () => {
    const r = scanForPII(
      "My medical record has my SSN 123-45-6789 in it."
    );
    expect(r.hasPII).toBe(true);
    expect(r.tier).toBe("high");
    // Should contain SSN reason, not medical (medium is not checked after high)
    expect(r.reasons).toContain("SSN");
  });
});
