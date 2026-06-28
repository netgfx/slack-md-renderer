/**
 * @file Bolt app wiring (§4). HTTP receiver on POST /slack/events. Three entry
 * points share one core (handlePreview):
 *   1. message shortcut "Render Markdown" (PRIMARY) — render a shared .md file
 *   2. /render slash command — paste raw Markdown
 *   3. companion "Render" button on file_shared (opt-in, per-channel allowlist)
 * Plus the "Download as HTML" button action.
 */

import bolt from '@slack/bolt';

import { fetchFileText, postCompanionButton } from './deliver.js';
import { handlePreview, handleDownload } from './slack/fileEntry.js';
import { buildInputModal, parseSubmission, RENDER_CALLBACK_ID } from './slack/inputModal.js';
import { buildLoadingView, buildConfirmationView, DOWNLOAD_ACTION_ID } from './slack/previewView.js';

const { App } = bolt;

const MESSAGE_SHORTCUT_ID = 'render_md_msg';
const COMPANION_ACTION_ID = 'companion_render';

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

// Opt-in companion-button channels (comma-separated channel ids). Empty => off.
const COMPANION_CHANNELS = new Set(
  (process.env.COMPANION_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean)
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

async function updateView(client, viewId, view) {
  return client.views.update({ view_id: viewId, view });
}

// --- Entry point 1: message shortcut (PRIMARY) ---------------------------------
app.shortcut(MESSAGE_SHORTCUT_ID, async ({ shortcut, ack, client, logger }) => {
  await ack();

  // Open a loading modal within the 3s trigger_id window.
  let viewId;
  try {
    const open = await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildLoadingView()
    });
    viewId = open.view.id;
  } catch (err) {
    logger.error('Failed to open loading modal:', err);
    return;
  }

  try {
    const file = firstMarkdownFile(shortcut.message);
    if (!file) {
      await updateView(client, viewId, buildConfirmationView({
        message: '⚠️ No Markdown (`.md`) file found on this message.'
      }));
      return;
    }
    const { text, filename } = await fetchFileText(client, { fileId: file.id, botToken: BOT_TOKEN });
    await handlePreview({ rawText: text, filename, client, viewId, logger });
  } catch (err) {
    logger.error('Shortcut preview failed:', err);
    await updateView(client, viewId, buildConfirmationView({
      message: `⚠️ Could not render that file: ${err.message}`
    })).catch(() => {});
  }
});

// --- Entry point 2: /render paste path -----------------------------------------
app.command('/render', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildInputModal() });
  } catch (err) {
    logger.error('Failed to open /render modal:', err);
  }
});

app.view(RENDER_CALLBACK_ID, async ({ ack, body, view, client, logger }) => {
  const { source, instructionFile } = parseSubmission(view);

  // Swap the input modal to a loading view, then render in place.
  await ack({ response_action: 'update', view: buildLoadingView() });

  try {
    await handlePreview({
      rawText: source,
      filename: '',
      forceInstruction: instructionFile,
      client,
      viewId: body.view.id,
      logger
    });
  } catch (err) {
    logger.error('Paste preview failed:', err);
    await updateView(client, body.view.id, buildConfirmationView({
      message: `⚠️ Could not render: ${err.message}`
    })).catch(() => {});
  }
});

// --- Download as HTML action ---------------------------------------------------
app.action(DOWNLOAD_ACTION_ID, async ({ ack, body, action, client, logger }) => {
  await ack();
  try {
    await handleDownload({
      token: action.value,
      userId: body.user.id,
      viewId: body.view.id,
      client
    });
  } catch (err) {
    logger.error('HTML download failed:', err);
    await updateView(client, body.view.id, buildConfirmationView({
      message: `⚠️ Could not send the HTML: ${err.message}`
    })).catch(() => {});
  }
});

// --- Entry point 3: companion button (opt-in) ----------------------------------
app.action(COMPANION_ACTION_ID, async ({ ack, body, action, client, logger }) => {
  await ack();
  let viewId;
  try {
    const open = await client.views.open({
      trigger_id: body.trigger_id,
      view: buildLoadingView()
    });
    viewId = open.view.id;
    const { text, filename } = await fetchFileText(client, { fileId: action.value, botToken: BOT_TOKEN });
    await handlePreview({ rawText: text, filename, client, viewId, logger });
  } catch (err) {
    logger.error('Companion render failed:', err);
    if (viewId) {
      await updateView(client, viewId, buildConfirmationView({
        message: `⚠️ Could not render that file: ${err.message}`
      })).catch(() => {});
    }
  }
});

app.event('file_shared', async ({ event, client, logger }) => {
  try {
    const channel = event.channel_id;
    if (!COMPANION_CHANNELS.has(channel)) return; // off unless allowlisted
    const info = await client.files.info({ file: event.file_id });
    const name = String(info.file?.name || '').toLowerCase();
    if (!(name.endsWith('.md') || name.endsWith('.markdown') || info.file?.filetype === 'markdown')) {
      return;
    }
    await postCompanionButton(client, {
      channel,
      fileId: event.file_id,
      filename: info.file?.name,
      actionId: COMPANION_ACTION_ID
    });
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
})();
