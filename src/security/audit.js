/**
 * @file Deterministic security audit (§6). No LLM. Pure parsers/regex/codepoint scans.
 *
 * auditMarkdown(raw, { strict }) -> {
 *   safe: boolean,
 *   severity: 'none'|'low'|'medium'|'high'|'critical',
 *   caution: boolean,        // medium in normal mode: render but warn
 *   strict: boolean,
 *   rulesetVersion: string,
 *   findings: Finding[]       // Finding = { id, category, severity, line, column, snippet }
 * }
 */

import { scanInvisible, normalizeForScan } from './normalize.js';
import { ruleset } from './ruleset.js';

/** Hard input cap (§6.3.6): anything larger is rejected outright. */
export const MAX_INPUT_CHARS = 50000;

/** Most findings we will report back (keeps warning payloads bounded). */
const MAX_FINDINGS = 100;

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const RANK_SEVERITY = ['none', 'low', 'medium', 'high', 'critical'];

/**
 * @param {string} raw the original Markdown source
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ safe: boolean, severity: string, caution: boolean, strict: boolean, rulesetVersion: string, findings: object[] }}
 */
export function auditMarkdown(raw, opts = {}) {
  const strict = opts.strict !== false; // default ON (instruction/SKILL files)
  const text = typeof raw === 'string' ? raw : String(raw ?? '');

  /** @type {object[]} */
  const findings = [];

  // 1. Invisible-character scan on the ORIGINAL bytes first (§6.1 step 1).
  findings.push(...scanInvisible(text));

  // 2. Hard length cap — reject outright; skip heavy regex on oversized input.
  if (text.length > MAX_INPUT_CHARS) {
    findings.push({
      id: 'markup-length-cap',
      category: 'markup-exploitation',
      severity: 'high',
      line: 1,
      column: 1,
      snippet: `input length ${text.length} exceeds cap ${MAX_INPUT_CHARS}`
    });
    return finalize(findings, strict);
  }

  // 3. Normalized copy (NFKC + invisibles removed) for keyword/pattern scanning (§6.1 step 2).
  const normalized = normalizeForScan(text);

  // 4. Run compiled pattern matchers (§6.3).
  for (const rule of ruleset.rules) {
    if (rule.strictOnly && !strict) continue;
    findings.push(...runRule(rule, normalized));
  }

  return finalize(findings, strict);
}

/**
 * Run a single compiled rule across the normalized text.
 * @param {import('./ruleset.js').CompiledRule} rule
 * @param {string} text
 * @returns {object[]}
 */
function runRule(rule, text) {
  const out = [];
  // Reset lastIndex defensively; rules are shared across requests.
  rule.regex.lastIndex = 0;

  // Non-global regexes would loop forever with exec(); ensure global iteration.
  const re = rule.regex.global ? rule.regex : new RegExp(rule.regex.source, rule.regex.flags + 'g');

  let match;
  while ((match = re.exec(text)) !== null) {
    const matchText = match[0];
    // Guard against zero-length matches causing an infinite loop.
    if (match.index === re.lastIndex) re.lastIndex++;
    if (matchText.length === 0) continue;

    if (rule.exclude && rule.exclude.test(matchText)) continue;

    const { line, column } = indexToLineCol(text, match.index);
    out.push({
      id: rule.id,
      category: rule.category,
      severity: rule.severity,
      line,
      column,
      snippet: makeSnippet(matchText)
    });

    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/**
 * Aggregate severity and map to action (§6.4).
 * @param {object[]} findings
 * @param {boolean} strict
 */
function finalize(findings, strict) {
  if (findings.length > MAX_FINDINGS) findings = findings.slice(0, MAX_FINDINGS);

  let topRank = 0;
  for (const f of findings) {
    const r = SEVERITY_RANK[f.severity] ?? 0;
    if (r > topRank) topRank = r;
  }
  const severity = RANK_SEVERITY[topRank];

  // Block threshold: high+ always; medium also blocks in strict mode.
  const blockRank = strict ? SEVERITY_RANK.medium : SEVERITY_RANK.high;
  const safe = topRank < blockRank;

  // Caution: a medium finding that we render anyway (normal mode only).
  const caution = safe && topRank === SEVERITY_RANK.medium;

  return {
    safe,
    severity,
    caution,
    strict,
    rulesetVersion: ruleset.version,
    findings
  };
}

/**
 * Convert a UTF-16 index in `text` to a 1-based {line, column}.
 * @param {string} text
 * @param {number} index
 */
export function indexToLineCol(text, index) {
  let line = 1;
  let column = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * Compact a matched substring for display: collapse whitespace, truncate.
 * @param {string} s
 */
function makeSnippet(s) {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  const MAX = 120;
  return collapsed.length > MAX ? collapsed.slice(0, MAX) + '…' : collapsed;
}
