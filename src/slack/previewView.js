/**
 * @file Preview modal views (§4b.3): a loading view, the result view (rendered
 * Markdown + a conditional "Download as HTML" button), and a post-download
 * confirmation view. The result view never contains HTML — only rendered Markdown.
 */

import { buildCautionBanner } from './warningView.js';

export const PREVIEW_CALLBACK_ID = 'render_preview';
export const DOWNLOAD_ACTION_ID = 'download_html';

/** Slack modals allow at most 100 blocks; keep headroom for chrome. */
const MAX_PREVIEW_BLOCKS = 90;

/**
 * Lightweight loading view opened within the 3s trigger_id window (§4b.3 step 1).
 * @param {string} [message]
 * @returns {object}
 */
export function buildLoadingView(message = 'Rendering…') {
  return {
    type: 'modal',
    callback_id: PREVIEW_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Render Markdown' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:hourglass_flowing_sand: *${message}*` } }
    ]
  };
}

/**
 * The result view: rendered Markdown preview + optional HTML-download button.
 * @param {object} args
 * @param {object[]} args.previewBlocks rendered preview blocks (markdown or mrkdwn)
 * @param {boolean} args.allowHtmlExport whether to show the download button
 * @param {string} [args.token] cache token used by the download action
 * @param {string} [args.filename]
 * @param {object} [args.audit] audit result (for an optional caution banner)
 * @returns {object} a Slack `modal` view payload
 */
export function buildResultView({ previewBlocks, allowHtmlExport, token, filename, audit }) {
  const blocks = [];

  if (audit && audit.caution) blocks.push(buildCautionBanner(audit));

  let body = previewBlocks;
  if (body.length > MAX_PREVIEW_BLOCKS) {
    body = body.slice(0, MAX_PREVIEW_BLOCKS);
    body.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '…preview truncated (document too long for one modal).' }]
    });
  }
  blocks.push(...body);

  if (allowHtmlExport) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: DOWNLOAD_ACTION_ID,
            text: { type: 'plain_text', text: '⬇️ Download as HTML' },
            style: 'primary',
            value: token ?? ''
          }
        ]
      }
    );
  }

  return {
    type: 'modal',
    callback_id: PREVIEW_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Rendered Markdown' },
    close: { type: 'plain_text', text: 'Done' },
    private_metadata: JSON.stringify({ token: token ?? '', filename: filename ?? '' }),
    blocks
  };
}

/**
 * Confirmation view shown after a successful HTML DM (§4b.4 step 3).
 * @param {{ message?: string, permalink?: string }} [args]
 * @returns {object}
 */
export function buildConfirmationView({ message = '✅ Sent the HTML to your DMs with this app.', permalink } = {}) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: message } }];
  if (permalink) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'open_html_permalink',
          text: { type: 'plain_text', text: 'Open file' },
          url: permalink
        }
      ]
    });
  }
  return {
    type: 'modal',
    callback_id: PREVIEW_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Done' },
    close: { type: 'plain_text', text: 'Close' },
    blocks
  };
}
