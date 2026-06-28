/**
 * @file Unified preview core (§4d). All three entry points (message shortcut,
 * companion button, /render paste) resolve to handlePreview() once the raw text is
 * in hand. It classifies, audits, and updates the already-open modal in place —
 * to the warning view when blocked, or the result view (Markdown preview +
 * conditional HTML download) when safe.
 */

import { classifyMarkdown } from '../classify.js';
import { auditMarkdown } from '../security/audit.js';
import { toSlackBlocks, toMrkdwnSections, toHtml } from '../render.js';
import { buildWarningView } from './warningView.js';
import { buildResultView, buildConfirmationView } from './previewView.js';
import { dmHtmlFile } from '../deliver.js';
import * as cache from '../previewCache.js';

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

  // Try the richer `markdown` block first; fall back to mrkdwn on invalid_blocks.
  const markdownView = buildResultView({
    previewBlocks: toSlackBlocks(rawText),
    allowHtmlExport: classification.allowHtmlExport,
    token,
    filename,
    audit
  });

  try {
    await client.views.update({ view_id: viewId, view: markdownView });
  } catch (err) {
    if (isInvalidBlocks(err)) {
      const fallbackView = buildResultView({
        previewBlocks: toMrkdwnSections(rawText),
        allowHtmlExport: classification.allowHtmlExport,
        token,
        filename,
        audit
      });
      await client.views.update({ view_id: viewId, view: fallbackView });
    } else {
      if (logger) logger.error('views.update failed:', err);
      throw err;
    }
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

function isInvalidBlocks(err) {
  const data = err?.data;
  const msg = String(err?.message || '');
  return data?.error === 'invalid_blocks' || /invalid_blocks/.test(msg);
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
