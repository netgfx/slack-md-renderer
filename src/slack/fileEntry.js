/**
 * @file Unified render core. Every entry point (message shortcut, /render paste,
 * file_shared auto-render) classifies + audits, then delivers the rendered Markdown
 * as a MESSAGE — ephemeral for the interactive paths, a threaded reply for
 * auto-render. Messages support Slack's native `markdown` block, so renders are full
 * fidelity (tables included), unlike modals (which only accept `mrkdwn`).
 */

import { classifyMarkdown } from '../classify.js';
import { auditMarkdown } from '../security/audit.js';
import { toSlackBlocks, toHtml } from '../render.js';
import { buildWarningBlocks, buildBlockedNotice, buildCautionBanner } from './warningView.js';
import { dmHtmlFile, postThreadedBlocks, postViaResponseUrl } from '../deliver.js';
import * as cache from '../previewCache.js';

export const DOWNLOAD_ACTION_ID = 'download_html';

/** Max threaded reply messages per auto-render (each carries one <12k markdown block). */
const MAX_AUTO_MESSAGES = 5;

/**
 * Build the Block Kit blocks for a single-message render. Safe content renders as a
 * native `markdown` block (tables included). Blocked content returns the full
 * findings — fine for an ephemeral message, which only the requester sees.
 * @param {{ rawText: string, filename?: string, forceInstruction?: boolean, withDownload?: boolean }} args
 * @returns {{ classify: object, audit: object, blocks: object[], text: string }}
 */
export function renderForMessage({ rawText, filename = '', forceInstruction = false, withDownload = true }) {
  const classify = classifyMarkdown({ filename, raw: rawText, forceInstruction });
  const audit = auditMarkdown(rawText, { strict: classify.strict });

  if (!audit.safe) {
    return { classify, audit, blocks: buildWarningBlocks(audit), text: 'Rendering blocked by security audit' };
  }

  const chunks = toSlackBlocks(rawText); // native markdown blocks (full fidelity)
  const blocks = [];
  if (audit.caution) blocks.push(buildCautionBanner(audit));
  blocks.push(chunks[0]); // first <12k block fits a single message

  if (chunks.length > 1) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '…preview truncated (document too long for one message). Download the HTML for the full version.'
      }]
    });
  }

  if (classify.allowHtmlExport) {
    if (withDownload) {
      const token = cache.put({ source: rawText, filename, allowHtmlExport: true });
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          action_id: DOWNLOAD_ACTION_ID,
          text: { type: 'plain_text', text: '⬇️ Download as HTML' },
          style: 'primary',
          value: token
        }]
      });
    } else {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '💡 Want an HTML file? Use the message’s `⋯` menu → *Render Markdown* → Download as HTML.'
        }]
      });
    }
  }

  return { classify, audit, blocks, text: 'Rendered Markdown' };
}

/**
 * Auto-render path (file_shared event). Classifies + audits, then posts the result as
 * a threaded reply. Blocked files get a concise public notice (no payload broadcast).
 * @param {object} args
 * @param {string} args.rawText
 * @param {string} [args.filename]
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} args.channel
 * @param {string} [args.threadTs]
 * @returns {Promise<{ classify: object, audit: object }>}
 */
export async function handleAutoRender({ rawText, filename = '', client, channel, threadTs }) {
  const classify = classifyMarkdown({ filename, raw: rawText });
  const audit = auditMarkdown(rawText, { strict: classify.strict });

  if (!audit.safe) {
    await postThreadedBlocks(client, {
      channel,
      threadTs,
      blocks: buildBlockedNotice(audit, filename),
      text: 'Markdown not rendered (security audit)'
    });
    return { classify, audit };
  }

  const chunks = toSlackBlocks(rawText);
  const shown = chunks.slice(0, MAX_AUTO_MESSAGES);

  for (let i = 0; i < shown.length; i++) {
    const blocks = [];
    if (i === 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:memo: Rendered *${filename || 'Markdown'}*` }]
      });
      if (audit.caution) blocks.push(buildCautionBanner(audit));
    }
    blocks.push(shown[i]); // one <12k markdown block per message (respects the cap)
    if (i === shown.length - 1) {
      if (chunks.length > MAX_AUTO_MESSAGES) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '…preview truncated. Use the `⋯` → *Render Markdown* shortcut for the rest.' }]
        });
      }
      if (classify.allowHtmlExport) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '💡 Want an HTML file? Use the message’s `⋯` menu → *Render Markdown* → Download as HTML.' }]
        });
      }
    }
    await postThreadedBlocks(client, { channel, threadTs, blocks, text: 'Rendered Markdown' });
  }

  return { classify, audit };
}

/**
 * "Download as HTML" action: regenerate HTML from the cached source and DM it, then
 * confirm via the message's response_url.
 * @param {object} args
 * @param {string} args.token cache token from the button value
 * @param {string} args.userId
 * @param {string} args.responseUrl response_url of the message the button is on
 * @param {import('@slack/web-api').WebClient} args.client
 * @returns {Promise<void>}
 */
export async function handleDownload({ token, userId, responseUrl, client }) {
  const entry = cache.get(token);

  if (!entry || !entry.allowHtmlExport) {
    await postViaResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      replace_original: false,
      text: entry
        ? '⚠️ HTML export is not available for instruction/skill files.'
        : '⚠️ This preview expired. Please re-run the render and try again.'
    });
    return;
  }

  const html = toHtml(entry.source);
  const filename = htmlNameFor(entry.filename);
  await dmHtmlFile(client, { userId, filename, html });
  cache.drop(token);

  await postViaResponseUrl(responseUrl, {
    response_type: 'ephemeral',
    replace_original: false,
    text: '✅ Sent the HTML to your DMs with this app.'
  });
}

/**
 * Derive an .html filename from the source filename.
 * @param {string} filename
 * @returns {string}
 */
export function htmlNameFor(filename) {
  const base = String(filename || '').replace(/^.*[\\/]/, '').trim();
  if (!base) return 'rendered.html';
  return base.replace(/\.(md|markdown|mdc)$/i, '') + '.html';
}
