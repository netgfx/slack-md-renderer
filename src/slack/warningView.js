/**
 * @file Warning UX for blocked renders and caution banners (§7).
 * No "render anyway" bypass is ever offered for critical/high findings.
 */

const SEVERITY_ICON = {
  critical: '⛔',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  none: '⚪'
};

const CLOSING_NOTE =
  'This content was not rendered. If you believe this is a false positive, ' +
  'review the raw source. For invisible characters, the `‹U+XXXX›` annotation ' +
  'shows what was hiding.';

/**
 * Block Kit blocks listing findings for a blocked render (§7). Shown in the ephemeral
 * message render (private to the requester, so listing snippets is fine).
 * @param {object} audit
 * @returns {object[]}
 */
export function buildWarningBlocks(audit) {
  const findingLines = audit.findings.map(formatFinding);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚫 Rendering blocked — ${audit.findings.length} finding(s)` }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `Audit ran in *${audit.strict ? 'strict' : 'normal'}* mode. ` +
          `Highest severity: *${audit.severity}*.`
      }
    },
    { type: 'divider' }
  ];

  for (const chunk of chunkLines(findingLines, 3000)) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  }

  blocks.push(
    { type: 'divider' },
    { type: 'context', elements: [{ type: 'mrkdwn', text: CLOSING_NOTE }] }
  );

  return blocks;
}

/**
 * Concise public blocked notice for auto-render (threaded reply). Deliberately does
 * NOT dump finding snippets — broadcasting the annotated payload into a channel would
 * itself be undesirable. Points to the shortcut for full details.
 * @param {object} audit
 * @param {string} [filename]
 * @returns {object[]} Block Kit blocks
 */
export function buildBlockedNotice(audit, filename) {
  const categories = [...new Set(audit.findings.map((f) => f.category))].join(', ');
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `🚫 *${filename || 'Markdown'}* was not rendered — the security audit found ` +
          `*${audit.findings.length}* finding(s) (highest: *${audit.severity}*).`
      }
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `Categories: ${categories}. Open the message’s \`⋯\` menu → *Render Markdown* ` +
            'for details. No bypass is offered for high/critical findings.'
        }
      ]
    }
  ];
}

/**
 * Caution banner prepended to rendered output for MEDIUM findings in normal mode
 * (§6.4) — rendered, but flagged.
 * @param {object} audit
 * @returns {object} a context block
 */
export function buildCautionBanner(audit) {
  const categories = [...new Set(audit.findings.map((f) => f.category))].join(', ');
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `⚠️ *Rendered with caution* — ${audit.findings.length} ${audit.severity} finding(s): ${categories}. Review before trusting this content.`
      }
    ]
  };
}

/**
 * @param {object} f
 * @returns {string}
 */
function formatFinding(f) {
  const icon = SEVERITY_ICON[f.severity] ?? '•';
  const snippet = (f.snippet ?? '').replace(/`/g, 'ˋ'); // avoid breaking code spans
  return `${icon} *${f.severity}* · \`${f.category}\` · ${f.line}:${f.column} · ${snippet}`;
}

/**
 * Greedily pack lines into <=maxLen mrkdwn strings.
 * @param {string[]} lines
 * @param {number} maxLen
 * @returns {string[]}
 */
function chunkLines(lines, maxLen) {
  const out = [];
  let cur = '';
  for (const line of lines) {
    const candidate = cur ? cur + '\n' + line : line;
    if (candidate.length > maxLen && cur) {
      out.push(cur);
      cur = line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : ['(no findings)'];
}
