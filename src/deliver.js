/**
 * @file Slack Web API delivery (§4b). Thin wrappers so the handlers stay declarative
 * and the API surface we depend on lives in one place.
 */

/** Reject files larger than this (§4b.2). */
export const MAX_FILE_BYTES = 256 * 1024;

const MD_EXTENSIONS = ['.md', '.markdown'];

/**
 * Fetch the text content of a shared Markdown file: files.info, then an
 * authenticated download of url_private. Enforces extension + size caps (§4b.2).
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ fileId: string, botToken: string }} args
 * @returns {Promise<{ text: string, filename: string }>}
 */
export async function fetchFileText(client, { fileId, botToken }) {
  const info = await client.files.info({ file: fileId });
  const file = info.file;
  if (!file) throw new Error('file not found');

  const name = String(file.name || '');
  const lower = name.toLowerCase();
  const okExt = MD_EXTENSIONS.some((e) => lower.endsWith(e)) || file.filetype === 'markdown';
  if (!okExt) throw new Error(`unsupported file type: ${file.filetype || name}`);

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
  return { text: buf.toString('utf8'), filename: name };
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
