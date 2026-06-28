/**
 * @file Unified preview core (§4d). All three entry points (message shortcut,
 * companion button, /render paste) resolve to handlePreview() once the raw text is
 * in hand. It classifies, audits, and updates the already-open modal in place —
 * to the warning view when blocked, or the result view (Markdown preview +
 * conditional HTML download) when safe.
 */

import { classifyMarkdown } from '../classify.js';
import { auditMarkdown } from '../security/audit.js';
import { toMrkdwnSections, toSlackBlocks, toHtml } from '../render.js';
import { buildWarningView, buildBlockedNotice, buildCautionBanner } from './warningView.js';
import { buildResultView, buildConfirmationView } from './previewView.js';
import { dmHtmlFile, postThreadedBlocks } from '../deliver.js';
import * as cache from '../previewCache.js';

/** Max threaded reply messages per render (each carries one <12k markdown block). */
const MAX_AUTO_MESSAGES = 5;

/**
 * Classify + audit + render into an already-open modal (viewId).
 * @param {object} args
 * @param {string} args.rawText the Markdown source
 * @param {string} [args.filename]
 * @param {boolean} [args.forceInstruction] paste-path checkbox
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} args.viewId the open (loading) modal's id
 * @param {{ error: Function }} [args.logger]
 * @returns {Promise<{ classify: object, audit: object }>}
 */
export async function handlePreview({ rawText, filename = '', forceInstruction = false, client, viewId, logger }) {
  const classification = classifyMarkdown({ filename, raw: rawText, forceInstruction });
  const audit = auditMarkdown(rawText, { strict: classification.strict });

  if (!audit.safe) {
    await client.views.update({ view_id: viewId, view: buildWarningView(audit) });
    return { classify: classification, audit };
  }

  const token = cache.put({
    source: rawText,
    filename,
    allowHtmlExport: classification.allowHtmlExport
  });

  // Modals only support `mrkdwn` text objects (not the `markdown` block, which
  // errors with invalid_arguments), so render converted Slack mrkdwn directly.
  const view = buildResultView({
    previewBlocks: toMrkdwnSections(rawText),
    allowHtmlExport: classification.allowHtmlExport,
    token,
    filename,
    audit
  });

  try {
    await client.views.update({ view_id: viewId, view });
  } catch (err) {
    if (logger) logger.error('views.update failed:', err);
    throw err;
  }

  return { classify: classification, audit };
}

/**
 * Auto-render path (file_shared event, no trigger_id ⇒ no modal). Classifies and
 * audits the file, then posts the result as a threaded reply. Messages support the
 * `markdown` block, so this renders full fidelity (including tables). Blocked files
 * get a concise public notice (no payload broadcast).
 * @param {object} args
 * @param {string} args.rawText
 * @param {string} [args.filename]
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} args.channel
 * @param {string} [args.threadTs] message ts to reply under
 * @param {{ error: Function }} [args.logger]
 * @returns {Promise<{ classify: object, audit: object }>}
 */
export async function handleAutoRender({ rawText, filename = '', client, channel, threadTs }) {
  const classification = classifyMarkdown({ filename, raw: rawText });
  const audit = auditMarkdown(rawText, { strict: classification.strict });

  if (!audit.safe) {
    await postThreadedBlocks(client, {
      channel,
      threadTs,
      blocks: buildBlockedNotice(audit, filename),
      text: 'Markdown not rendered (security audit)'
    });
    return { classify: classification, audit };
  }

  const chunks = toSlackBlocks(rawText); // markdown blocks (tables OK in messages)
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
    blocks.push(shown[i]); // a single <12k markdown block (respects the per-message cap)
    if (i === shown.length - 1) {
      if (chunks.length > MAX_AUTO_MESSAGES) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '…preview truncated. Use the `⋯` → *Render Markdown* shortcut for the rest.' }]
        });
      }
      if (classification.allowHtmlExport) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '💡 Want an HTML file? Use the message’s `⋯` menu → *Render Markdown* → Download as HTML.' }]
        });
      }
    }
    await postThreadedBlocks(client, { channel, threadTs, blocks, text: 'Rendered Markdown' });
  }

  return { classify: classification, audit };
}

/**
 * "Download as HTML" action: regenerate HTML from the cached source and DM it.
 * @param {object} args
 * @param {string} args.token cache token from the button value
 * @param {string} args.userId
 * @param {string} args.viewId modal to update with confirmation
 * @param {import('@slack/web-api').WebClient} args.client
 * @returns {Promise<void>}
 */
export async function handleDownload({ token, userId, viewId, client }) {
  const entry = cache.get(token);

  if (!entry || !entry.allowHtmlExport) {
    await client.views.update({
      view_id: viewId,
      view: buildConfirmationView({
        message: entry
          ? '⚠️ HTML export is not available for instruction/skill files.'
          : '⚠️ This preview expired. Please re-run the render and try again.'
      })
    });
    return;
  }

  const html = toHtml(entry.source);
  const filename = htmlNameFor(entry.filename);
  const upload = await dmHtmlFile(client, { userId, filename, html });
  cache.drop(token);

  const permalink = firstPermalink(upload);
  await client.views.update({
    view_id: viewId,
    view: buildConfirmationView({ permalink })
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

function firstPermalink(upload) {
  const files = upload?.files || upload?.file ? [].concat(upload.files || upload.file) : [];
  for (const f of files) {
    if (f?.permalink) return f.permalink;
    if (Array.isArray(f?.files)) {
      for (const g of f.files) if (g?.permalink) return g.permalink;
    }
  }
  return undefined;
}
