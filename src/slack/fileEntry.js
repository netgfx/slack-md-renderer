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
import { fetchFileText, dmHtmlFile, postThreadedBlocks, postViaResponseUrl } from '../deliver.js';
import * as cache from '../previewCache.js';

export const DOWNLOAD_ACTION_ID = 'download_html';

/** Max threaded reply messages per auto-render (each carries one <12k markdown block). */
const MAX_AUTO_MESSAGES = 5;

/**
 * An "Download as HTML" actions block. The button value is either `file:<id>` (durable
 * — re-fetched + re-audited on click, used for persistent messages) or a cache token
 * (short-lived, used for the paste path which has no file).
 * @param {string} value
 * @returns {object}
 */
function htmlDownloadButton(value) {
  return {
    type: 'actions',
    elements: [{
      type: 'button',
      action_id: DOWNLOAD_ACTION_ID,
      text: { type: 'plain_text', text: '⬇️ Download as HTML' },
      style: 'primary',
      value
    }]
  };
}

/**
 * Build the Block Kit blocks for a single-message render. Safe content renders as a
 * native `markdown` block (tables included). Blocked content returns the full
 * findings — fine for an ephemeral message, which only the requester sees.
 * @param {{ rawText: string, filename?: string, forceInstruction?: boolean, fileId?: string }} args
 * @returns {{ classify: object, audit: object, blocks: object[], text: string }}
 */
export function renderForMessage({ rawText, filename = '', forceInstruction = false, fileId }) {
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
    // Durable file: button when we have a file id; cache token for the paste path.
    const value = fileId ? `file:${fileId}` : cache.put({ source: rawText, filename, allowHtmlExport: true });
    blocks.push(htmlDownloadButton(value));
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
 * @param {string} [args.fileId] enables a durable Download-as-HTML button
 * @returns {Promise<{ classify: object, audit: object }>}
 */
export async function handleAutoRender({ rawText, filename = '', client, channel, threadTs, fileId }) {
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
      if (classify.allowHtmlExport && fileId) {
        blocks.push(htmlDownloadButton(`file:${fileId}`));
      }
    }
    await postThreadedBlocks(client, { channel, threadTs, blocks, text: 'Rendered Markdown' });
  }

  return { classify, audit };
}

/**
 * "Download as HTML" action: DM a sanitized HTML file, then confirm via the message's
 * response_url. The button value is either `file:<id>` (durable — re-fetch + re-audit
 * the file now) or a cache token (paste path).
 * @param {object} args
 * @param {string} args.value button value (`file:<id>` or a cache token)
 * @param {string} args.userId
 * @param {string} args.responseUrl response_url of the message the button is on
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} [args.botToken] required for the `file:` path
 * @returns {Promise<void>}
 */
export async function handleDownload({ value, userId, responseUrl, client, botToken }) {
  const reply = (text) =>
    postViaResponseUrl(responseUrl, { response_type: 'ephemeral', replace_original: false, text });
  const sendHtml = async (filename, source) => {
    await dmHtmlFile(client, { userId, filename: htmlNameFor(filename), html: toHtml(source) });
    await reply('✅ Sent the HTML to your DMs with this app.');
  };

  // Durable path: re-fetch + re-audit the file on click.
  if (typeof value === 'string' && value.startsWith('file:')) {
    const fileId = value.slice('file:'.length);
    let text, filename;
    try {
      ({ text, filename } = await fetchFileText(client, { fileId, botToken }));
    } catch (err) {
      await reply(`⚠️ Could not read the file: ${err.message}`);
      return;
    }
    const classify = classifyMarkdown({ filename, raw: text });
    if (!classify.allowHtmlExport) {
      await reply('⚠️ HTML export is not available for instruction/skill files.');
      return;
    }
    if (!auditMarkdown(text, { strict: classify.strict }).safe) {
      await reply('⚠️ This file did not pass the security audit, so it can’t be exported.');
      return;
    }
    await sendHtml(filename, text);
    return;
  }

  // Cache-token path (paste render).
  const entry = cache.get(value);
  if (!entry || !entry.allowHtmlExport) {
    await reply(entry
      ? '⚠️ HTML export is not available for instruction/skill files.'
      : '⚠️ This preview expired. Please re-run the render and try again.');
    return;
  }
  await sendHtml(entry.filename, entry.source);
  cache.drop(value);
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
