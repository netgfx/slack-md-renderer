/**
 * @file Slack Web API delivery (§4b). Thin wrappers so the handlers stay declarative
 * and the API surface we depend on lives in one place.
 */

/** Reject files larger than this (§4b.2). */
export const MAX_FILE_BYTES = 256 * 1024;

const MD_EXTENSIONS = ['.md', '.markdown'];

/**
 * Is this Slack file object a Markdown file?
 * @param {object} file
 * @returns {boolean}
 */
export function isMarkdownFile(file) {
  const name = String(file?.name || '').toLowerCase();
  return MD_EXTENSIONS.some((e) => name.endsWith(e)) || file?.filetype === 'markdown';
}

/**
 * Authenticated download of a (already fetched) file's text, with extension + size
 * caps (§4b.2).
 * @param {object} file a Slack file object (from files.info)
 * @param {string} botToken
 * @returns {Promise<string>}
 */
export async function downloadFileText(file, botToken) {
  if (!file) throw new Error('file not found');
  if (!isMarkdownFile(file)) throw new Error(`unsupported file type: ${file.filetype || file.name}`);
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${file.size} bytes (cap ${MAX_FILE_BYTES})`);
  }

  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error('file has no downloadable URL');

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${buf.byteLength} bytes (cap ${MAX_FILE_BYTES})`);
  }
  return buf.toString('utf8');
}

/**
 * Fetch the text content of a shared Markdown file: files.info, then download.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ fileId: string, botToken: string }} args
 * @returns {Promise<{ text: string, filename: string, file: object }>}
 */
export async function fetchFileText(client, { fileId, botToken }) {
  const info = await client.files.info({ file: fileId });
  const file = info.file;
  const text = await downloadFileText(file, botToken);
  return { text, filename: String(file.name || ''), file };
}

/**
 * Find the timestamp of the message that shared a file into a channel, so a reply
 * can be threaded under it. Returns undefined if not found.
 * @param {object} file a Slack file object (from files.info, includes `shares`)
 * @param {string} channel
 * @returns {string|undefined}
 */
export function shareThreadTs(file, channel) {
  const shares = file?.shares || {};
  let best;
  for (const group of [shares.public, shares.private]) {
    const arr = (group && group[channel]) || [];
    for (const s of arr) {
      if (s?.ts && (!best || Number(s.ts) > Number(best))) best = s.ts;
    }
  }
  return best;
}

/**
 * Post a message to a Slack `response_url` (from a slash command / shortcut / message
 * action). Works without channel membership and supports the native `markdown` block.
 * @param {string} responseUrl
 * @param {object} payload a Slack message payload (blocks, text, response_type, replace_original)
 * @returns {Promise<Response>}
 */
export async function postViaResponseUrl(responseUrl, payload) {
  const resp = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error(`response_url post failed: HTTP ${resp.status}`);
  return resp;
}

/**
 * Post Block Kit blocks, optionally as a threaded reply.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ channel: string, threadTs?: string, blocks: object[], text?: string }} args
 * @returns {Promise<object>}
 */
export function postThreadedBlocks(client, { channel, threadTs, blocks, text }) {
  return client.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    blocks,
    text: text ?? 'Rendered Markdown'
  });
}

/**
 * DM the generated HTML file to the requesting user (§4b.4). Most reliable delivery:
 * open the IM, then upload into it. Returns the upload response.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ userId: string, filename: string, html: string, comment?: string }} args
 * @returns {Promise<object>}
 */
export async function dmHtmlFile(client, { userId, filename, html, comment }) {
  const im = await client.conversations.open({ users: userId });
  const channelId = im.channel?.id;
  if (!channelId) throw new Error('could not open DM channel');
  return client.files.uploadV2({
    channel_id: channelId,
    filename,
    title: filename,
    content: html,
    initial_comment: comment ?? 'Rendered Markdown (sanitized HTML)'
  });
}

/**
 * Post a small companion message with a visible "Render" button beneath a shared
 * `.md` file (§4b.1, opt-in entry point 3).
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ channel: string, fileId: string, filename?: string, actionId: string }} args
 * @returns {Promise<object>}
 */
export function postCompanionButton(client, { channel, fileId, filename, actionId }) {
  return client.chat.postMessage({
    channel,
    text: `Render ${filename || 'this Markdown file'}?`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:page_facing_up: *${filename || 'Markdown file'}*` },
        accessory: {
          type: 'button',
          action_id: actionId,
          text: { type: 'plain_text', text: 'Render' },
          value: fileId
        }
      }
    ]
  });
}

/**
 * Post an ephemeral notice to the invoking user.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ channel: string, user: string, blocks?: object[], text?: string }} args
 * @returns {Promise<object>}
 */
export function postEphemeral(client, { channel, user, blocks, text }) {
  return client.chat.postEphemeral({
    channel,
    user,
    blocks,
    text: text ?? 'Markdown renderer notice'
  });
}
