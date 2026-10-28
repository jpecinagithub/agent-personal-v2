// F4 T-V2-039 (RF-V2-049, RF-V2-075): untrusted-content scanning.
//
// Pages, documents and emails are DATA, never instructions. Any
// instruction found in untrusted content that tries to (a) change the
// goal, (b) request secrets, (c) execute code, or (d) widen navigation
// destinations is REJECTED and recorded with its source. Rejection is
// the whole behaviour: nothing in this module acts on the instruction,
// follows its link, or stores its payload.

import { randomUUID } from "node:crypto";
import { sanitiseText } from "./limits.mjs";

const PATTERNS = [
  { category: "change_goal", re: /(ignore|disregard|forget|override)\s+(all\s+|your\s+|the\s+|previous\s+|prior\s+|earlier\s+){0,3}(instructions|prompt|goal|task)/i, label: "ignore previous instructions / goal override" },
  { category: "change_goal", re: /(you are now|your new (goal|task|instruction) is|instead, (apply|do|send|go))/i, label: "goal replacement" },
  { category: "request_secret", re: /(send|share|reveal|paste|enter|provide)\s+(me\s+)?(your\s+)?(api[_-]?key|password|secret|token|otp|verification code|credentials)/i, label: "request for a secret or credential" },
  { category: "request_secret", re: /(api[_-]?key|password|secret)\s*[:=]/i, label: "secret value assignment pattern" },
  { category: "execute_code", re: /(run|execute|eval)\s+(this\s+)?(code|script|command|shell)/i, label: "code execution instruction" },
  { category: "execute_code", re: /<script[\s>]|javascript\s*:|on\w+\s*=\s*["'][^"']*\(/i, label: "embedded script / event handler" },
  { category: "exfiltrate_data", re: /(send|forward|upload|share|exfiltrate)\s+[^.]{0,120}?\s+to\s+https?:\/\/[^\s]+/i, label: "instruction to send data to an external destination" },
  { category: "widen_navigation", re: /(navigate|go|redirect|open)\s+to\s+(https?:\/\/[^\s]+)/i, label: "navigation instruction to an external destination" },
  { category: "widen_navigation", re: /(click|visit|follow)\s+(this\s+)?(link|url)\s*:?\s*(https?:\/\/[^\s]+)/i, label: "link-following instruction to an external destination" },
  { category: "change_goal", re: /(do not (tell|inform|ask)|without (telling|asking|informing))\s+(the\s+)?user/i, label: "instruction to hide an action from the user" },
];

/**
 * Scan untrusted text. Returns every finding; `rejected` is true when
 * at least one malicious-instruction pattern matched. Excerpts are
 * sanitised (secrets/codes redacted, truncated) before they leave
 * this function.
 * @param {any} input
 */
export function scanUntrustedContent(input) {
  const { sourceKind, sourceRef = null, text } = input;
  if (typeof text !== "string") throw new Error("text is required");
  if (!["page", "document", "email"].includes(sourceKind)) throw new Error("sourceKind must be page, document or email");
  const findings = [];
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (match) {
      findings.push({
        category: pattern.category,
        label: pattern.label,
        excerpt: sanitiseText(match[0]),
      });
    }
  }
  return { rejected: findings.length > 0, sourceKind, sourceRef, findings };
}

/**
 * Scan and, when rejected, record the rejection with its source.
 * Returns the scan result plus the recorded row ids (empty when not
 * rejected). Recording never stores the full untrusted body — only
 * the sanitised excerpt of the matched pattern.
 * @param {any} db
 */
export function scanAndRecord(db, input) {
  const scan = scanUntrustedContent(input);
  const recordedIds = [];
  if (scan.rejected) {
    for (const finding of scan.findings) {
      const id = randomUUID();
      db.prepare("INSERT INTO rejected_instructions (id, source_kind, source_ref, category, excerpt) VALUES (?, ?, ?, ?, ?)").run(
        id, scan.sourceKind, scan.sourceRef, finding.category, finding.excerpt,
      );
      recordedIds.push(id);
    }
  }
  return { ...scan, recordedIds };
}

/** @param {any} db */
export function listRejectedInstructions(db, opts = {}) {
  const { sourceKind } = opts;
  const rows = sourceKind
    ? db.prepare("SELECT * FROM rejected_instructions WHERE source_kind = ? ORDER BY created_at ASC").all(sourceKind)
    : db.prepare("SELECT * FROM rejected_instructions ORDER BY created_at ASC").all();
  return rows;
}
