/**
 * @file Bolt app wiring (§4). HTTP receiver on POST /slack/events. Entry points:
 *   1. message shortcut "Render Markdown" (PRIMARY) — render a shared .md file
 *   2. /render slash command — paste raw Markdown (modal is just the text input)
 *   3. file_shared handling (opt-in): FILE_SHARED_MODE = off | auto | button
 * All renders are delivered as MESSAGES (ephemeral for 1–2, threaded reply for auto),
 * which support the native `markdown` block — full fidelity, tables included.
 * Plus the "Download as HTML" button action.
 */

import bolt from '@slack/bolt';

import {
  fetchFileText,
  downloadFileText,
  isMarkdownFile,
  shareThreadTs,
  postCompanionButton,
  postViaResponseUrl
} from './deliver.js';
import {
  renderForMessage,
  handleAutoRender,
  handleDownload,
  DOWNLOAD_ACTION_ID
} from './slack/fileEntry.js';
import { buildInputModal, parseSubmission, RENDER_CALLBACK_ID } from './slack/inputModal.js';

const { App } = bolt;

const MESSAGE_SHORTCUT_ID = 'render_md_msg';
const COMPANION_ACTION_ID = 'companion_render';
const RENDERING_TEXT = ':hourglass_flowing_sand: Rendering…';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

const BOT_TOKEN = requireEnv('SLACK_BOT_TOKEN');
const SIGNING_SECRET = requireEnv('SLACK_SIGNING_SECRET');

// file_shared handling: mode + the channels it's active in. Empty list => off.
const FILE_SHARED_MODE = (process.env.FILE_SHARED_MODE || 'off').toLowerCase(); // off | auto | button
const FILE_RENDER_CHANNELS = new Set(
  (process.env.FILE_RENDER_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

const app = new App({ token: BOT_TOKEN, signingSecret: SIGNING_SECRET });

/** Find the first Markdown file attached to a message. */
function firstMarkdownFile(message) {
  const files = message?.files || [];
  return files.find((f) => {
    const name = String(f.name || '').toLowerCase();
    return name.endsWith('.md') || name.endsWith('.markdown') || f.filetype === 'markdown';
  });
}

const errorPayload = (msg) => ({ response_type: 'ephemeral', replace_original: true, text: `⚠️ ${msg}` });

// --- Entry point 1: message shortcut (PRIMARY) ---------------------------------
app.shortcut(MESSAGE_SHORTCUT_ID, async ({ shortcut, ack, client, logger }) => {
  await ack();
  const responseUrl = shortcut.response_url;
  try {
    await postViaResponseUrl(responseUrl, { response_type: 'ephemeral', text: RENDERING_TEXT });

    const file = firstMarkdownFile(shortcut.message);
    if (!file) {
      await postViaResponseUrl(responseUrl, errorPayload('No Markdown (`.md`) file found on this message.'));
      return;
    }
    const { text, filename } = await fetchFileText(client, { fileId: file.id, botToken: BOT_TOKEN });
    const { blocks, text: fallback } = renderForMessage({ rawText: text, filename });
    await postViaResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      replace_original: true,
      blocks,
      text: fallback
    });
  } catch (err) {
    logger.error('Shortcut render failed:', err);
    await postViaResponseUrl(responseUrl, errorPayload(`Could not render that file: ${err.message}`)).catch(() => {});
  }
});

// --- Entry point 2: /render paste path ------------------------------------------
app.command('/render', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const view = buildInputModal();
    // Stash the command's response_url so the submit handler can post the result.
    view.private_metadata = JSON.stringify({ responseUrl: body.response_url });
    await client.views.open({ trigger_id: body.trigger_id, view });
  } catch (err) {
    logger.error('Failed to open /render modal:', err);
  }
});

app.view(RENDER_CALLBACK_ID, async ({ ack, view, logger }) => {
  await ack(); // close the modal
  const { source, instructionFile } = parseSubmission(view);
  let responseUrl;
  try {
    responseUrl = JSON.parse(view.private_metadata || '{}').responseUrl;
  } catch {
    responseUrl = undefined;
  }
  if (!responseUrl) return;

  try {
    const { blocks, text } = renderForMessage({ rawText: source, forceInstruction: instructionFile });
    await postViaResponseUrl(responseUrl, { response_type: 'ephemeral', blocks, text });
  } catch (err) {
    logger.error('Paste render failed:', err);
    await postViaResponseUrl(responseUrl, errorPayload(`Could not render: ${err.message}`)).catch(() => {});
  }
});

// --- Download as HTML action ----------------------------------------------------
app.action(DOWNLOAD_ACTION_ID, async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    await handleDownload({
      token: action.value,
      userId: body.user.id,
      responseUrl: body.response_url,
      client
    });
  } catch (err) {
    logger.error('HTML download failed:', err);
    if (body.response_url) {
      await postViaResponseUrl(body.response_url, errorPayload(`Could not send the HTML: ${err.message}`)).catch(() => {});
    }
  }
});

// --- Companion button action (used only when FILE_SHARED_MODE='button') ----------
app.action(COMPANION_ACTION_ID, async ({ ack, body, action, client, logger }) => {
  await ack();
  const responseUrl = body.response_url;
  try {
    await postViaResponseUrl(responseUrl, { response_type: 'ephemeral', text: RENDERING_TEXT });
    const { text, filename } = await fetchFileText(client, { fileId: action.value, botToken: BOT_TOKEN });
    const { blocks, text: fallback } = renderForMessage({ rawText: text, filename });
    await postViaResponseUrl(responseUrl, { response_type: 'ephemeral', replace_original: true, blocks, text: fallback });
  } catch (err) {
    logger.error('Companion render failed:', err);
    await postViaResponseUrl(responseUrl, errorPayload(`Could not render that file: ${err.message}`)).catch(() => {});
  }
});

// --- Entry point 3: file_shared (auto-render threaded reply, or companion button) -
app.event('file_shared', async ({ event, client, logger }) => {
  try {
    if (FILE_SHARED_MODE === 'off') return;
    const channel = event.channel_id;
    if (!FILE_RENDER_CHANNELS.has(channel)) return; // off unless allowlisted

    const info = await client.files.info({ file: event.file_id });
    const file = info.file;
    if (!isMarkdownFile(file)) return; // ignore non-.md (incl. our own HTML uploads)

    if (FILE_SHARED_MODE === 'auto') {
      const text = await downloadFileText(file, BOT_TOKEN);
      const threadTs = shareThreadTs(file, channel);
      await handleAutoRender({ rawText: text, filename: file.name, client, channel, threadTs });
    } else if (FILE_SHARED_MODE === 'button') {
      await postCompanionButton(client, {
        channel,
        fileId: event.file_id,
        filename: file.name,
        actionId: COMPANION_ACTION_ID
      });
    }
  } catch (err) {
    logger.error('file_shared handling failed:', err);
  }
});

// Surface unexpected errors instead of crashing the process.
app.error(async (error) => {
  console.error('Bolt app error:', error);
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ slack-md-renderer running on :${port} (POST /slack/events)`);
  console.log(`file_shared mode: ${FILE_SHARED_MODE}; channels: ${FILE_RENDER_CHANNELS.size}`);
})();
