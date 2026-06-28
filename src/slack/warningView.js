/**
 * @file Warning UX for blocked renders and caution banners (§7).
 * No "render anyway" bypass is ever offered for critical/high findings.
 */

import { BLOCK_IDS } from './inputModal.js';

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
 * Full modal view for the shortcut/button flow — `views.update` the loading modal
 * to this (§7 primary).
 * @param {object} audit
 * @returns {object} a Slack `modal` view payload
 */
export function buildWarningView(audit) {
  return {
    type: 'modal',
    callback_id: 'render_blocked',
    title: { type: 'plain_text', text: 'Rendering blocked' },
    close: { type: 'plain_text', text: 'Done' },
    blocks: buildWarningBlocks(audit)
  };
}

/**
 * view_submission response that surfaces a short inline error on the input block
 * (paste flow, §7).
 * @param {object} audit
 * @returns {object} a Slack response_action:'errors' payload
 */
export function buildBlockedResponse(audit) {
  const n = audit.findings.length;
  return {
    response_action: 'errors',
    errors: {
      [BLOCK_IDS.source]: `Rendering blocked — ${n} security finding${n === 1 ? '' : 's'} (${audit.severity}).`
    }
  };
}

/**
 * Block Kit blocks listing findings for a blocked render (§7). Reused by the modal
 * warning view and by an optional DM.
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
