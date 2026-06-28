/**
 * @file Invisible / hidden-Unicode detection (§6.2) and NFKC normalization (§6.1).
 *
 * Two responsibilities:
 *  1. scanInvisible(raw): scan the ORIGINAL bytes for invisible/hidden codepoints
 *     BEFORE any normalization strips them, returning findings with line/col and a
 *     visible-annotated snippet (e.g. `‹U+200B›`). Any hit is CRITICAL.
 *  2. normalizeForScan(raw): produce a NFKC-normalized copy with invisibles removed,
 *     used ONLY for keyword/pattern scanning so obfuscation cannot split keywords.
 */

/**
 * Format a codepoint as `U+XXXX` (min 4 hex digits, more for astral planes).
 * @param {number} cp
 * @returns {string}
 */
export function formatCodepoint(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Classify a codepoint as an invisible/hidden character of interest, or null if it
 * is ordinary visible text (or permitted whitespace: tab, LF, CR).
 * @param {number} cp
 * @returns {string|null} a short label describing the class, or null
 */
export function classifyInvisible(cp) {
  // Permit ordinary whitespace.
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return null;

  // C0 control characters (except the whitespace permitted above).
  if (cp <= 0x1f) return 'c0-control';
  // C1 control characters + DEL.
  if (cp >= 0x7f && cp <= 0x9f) return 'c1-control';

  // Soft hyphen.
  if (cp === 0x00ad) return 'soft-hyphen';

  // Zero-width characters, word joiner, ZWNBSP/BOM.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) {
    return 'zero-width';
  }

  // Bidirectional controls (Trojan-Source).
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
    return 'bidi-control';
  }

  // Unicode Tags block — invisible "tag" instructions, the headline 2026 attack.
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'unicode-tag';

  // Catch-all: any other general-category Cf (format) character.
  if (FORMAT_CHAR_RE.test(String.fromCodePoint(cp))) return 'format-char';

  return null;
}

// Compiled once; \p{Cf} matches Unicode general category "Format".
const FORMAT_CHAR_RE = /\p{Cf}/u;

/**
 * @typedef {Object} InvisibleFinding
 * @property {string} id
 * @property {string} category
 * @property {'critical'} severity
 * @property {number} line     1-based line number in the original text
 * @property {number} column   1-based column (codepoint index within the line)
 * @property {string} snippet  the line with invisible chars rendered as `‹U+XXXX›`
 * @property {string} klass    the invisible class label
 */

/**
 * Scan the original text for invisible/hidden codepoints.
 * @param {string} raw
 * @returns {InvisibleFinding[]}
 */
export function scanInvisible(raw) {
  /** @type {InvisibleFinding[]} */
  const findings = [];
  const lines = raw.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let col = 0; // codepoint column within the line, 0-based as we iterate
    let lineHasHit = false;
    /** @type {{ col: number, cp: number, klass: string }[]} */
    const hits = [];

    for (const ch of line) {
      col++;
      const cp = ch.codePointAt(0);
      const klass = classifyInvisible(cp);
      if (klass) {
        lineHasHit = true;
        hits.push({ col, cp, klass });
      }
    }

    if (lineHasHit) {
      const snippet = annotateLine(line);
      for (const hit of hits) {
        findings.push({
          id: `invisible-${hit.klass}`,
          category: 'hidden-unicode',
          severity: 'critical',
          line: lineIdx + 1,
          column: hit.col,
          snippet,
          klass: hit.klass
        });
      }
    }
  }

  return findings;
}

/**
 * Render a line with every invisible codepoint replaced by `‹U+XXXX›`,
 * so a human can see what was hiding. Truncated to keep warning views compact.
 * @param {string} line
 * @returns {string}
 */
export function annotateLine(line) {
  let out = '';
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (classifyInvisible(cp)) {
      out += `‹${formatCodepoint(cp)}›`;
    } else {
      out += ch;
    }
  }
  const MAX = 200;
  return out.length > MAX ? out.slice(0, MAX) + '…' : out;
}

/**
 * Produce a NFKC-normalized copy with invisible characters removed. Used ONLY for
 * keyword/pattern scanning so obfuscation (zero-width splits, compatibility forms)
 * cannot evade the matchers. Not used for rendering.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeForScan(raw) {
  const nfkc = raw.normalize('NFKC');
  let out = '';
  for (const ch of nfkc) {
    const cp = ch.codePointAt(0);
    if (classifyInvisible(cp)) continue; // drop invisibles so keywords re-join
    out += ch;
  }
  return out;
}
