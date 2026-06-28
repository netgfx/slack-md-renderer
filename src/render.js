/**
 * @file Render pipeline (§5). Deterministic, no LLM.
 *
 *  - toSlackBlocks(raw): audited raw Markdown -> native Slack `markdown` blocks,
 *    chunked under the 12k cumulative limit, never splitting a fenced code block.
 *  - toHtml(raw): Markdown -> sanitized standalone HTML document.
 *
 * markdown-it runs with html:false (MANDATORY — raw HTML is escaped, never emitted),
 * which together with sanitize-html guarantees the HTML file cannot carry script.
 */

import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const md = new MarkdownIt({
  html: false, // MANDATORY (§0.5): escape raw HTML, never emit it
  linkify: true,
  breaks: false,
  typographer: false // keep deterministic; no smart-quote substitution
});

/** Headroom under Slack's 12,000-char cumulative `markdown` limit (§5.2). */
export const SLACK_CHUNK = 11000;

const ENV_ALLOW_REMOTE_IMAGES = process.env.ALLOW_REMOTE_IMAGES === 'true';

/**
 * Render once; both output branches reuse this result object (DRY, §2).
 * @param {string} raw audited raw Markdown
 * @param {{ allowRemoteImages?: boolean }} [opts]
 * @returns {{ slackBlocks: object[], html: string }}
 */
export function renderMarkdown(raw, opts = {}) {
  return {
    slackBlocks: toSlackBlocks(raw),
    html: toHtml(raw, opts)
  };
}

/**
 * Slack-rendered mode: pass the audited raw Markdown into native `markdown` blocks
 * (Slack performs the translation — that is the block's purpose). Chunked to respect
 * the cumulative 12k limit.
 * @param {string} raw
 * @returns {{ type: 'markdown', text: string }[]}
 */
export function toSlackBlocks(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const chunks = splitOnBlockBoundaries(text, SLACK_CHUNK);
  return chunks.map((chunk) => ({ type: 'markdown', text: chunk }));
}

/** Slack `section` mrkdwn text cap. */
export const MRKDWN_CHUNK = 2900;

// Private-use sentinel for protecting code while transforming. Built without a
// literal control char in source.
const MARK = String.fromCodePoint(0xe000);

/**
 * Convert CommonMark to Slack's `mrkdwn` dialect for modal previews. Slack modals
 * do NOT support the `markdown` block — only `mrkdwn` text objects — and `mrkdwn`
 * differs from CommonMark (`*bold*`, no `#` headers, no tables). Fenced and inline
 * code are protected so their contents are never rewritten. Tables are left as-is
 * (Slack cannot render them; the HTML export gives full fidelity).
 * @param {string} src
 * @returns {string}
 */
export function mrkdwnFromCommonMark(src) {
  const text = typeof src === 'string' ? src : String(src ?? '');
  const codeStore = [];

  // 1. Protect fenced code blocks (strip the info string; Slack ignores languages).
  let out = text.replace(
    /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g,
    (_m, pre, _indent, _fence, body) => {
      const idx = codeStore.push('```\n' + body + '\n```') - 1;
      return pre + MARK + 'C' + idx + MARK;
    }
  );

  // 2. Protect inline code spans.
  out = out.replace(/`[^`\n]+`/g, (m) => {
    const idx = codeStore.push(m) - 1;
    return MARK + 'I' + idx + MARK;
  });

  // 3. Transform the remaining (non-code) text.
  out = out
    // ATX headings -> bold line (mrkdwn has no headers)
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*')
    // thematic breaks
    .replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '────────')
    // images -> alt text (Slack mrkdwn cannot inline images)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => alt || '')
    // links [text](url) -> <url|text>
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<$2|$1>')
    // bold ** / __ -> *
    .replace(/\*\*([^\n]+?)\*\*/g, '*$1*')
    .replace(/__([^\n]+?)__/g, '*$1*')
    // strikethrough ~~ -> ~
    .replace(/~~([^\n]+?)~~/g, '~$1~')
    // bullet markers -> •
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');

  // 4. Restore protected code.
  out = out.replace(new RegExp(MARK + 'C(\\d+)' + MARK, 'g'), (_m, i) => codeStore[Number(i)]);
  out = out.replace(new RegExp(MARK + 'I(\\d+)' + MARK, 'g'), (_m, i) => codeStore[Number(i)]);
  return out;
}

/**
 * Modal preview blocks: CommonMark converted to Slack `mrkdwn`, chunked into
 * `section` blocks under the per-block cap. This is the only preview path for modals
 * (the `markdown` block is unsupported there — it errors with invalid_arguments).
 * @param {string} raw
 * @returns {{ type: 'section', text: { type: 'mrkdwn', text: string } }[]}
 */
export function toMrkdwnSections(raw) {
  const converted = mrkdwnFromCommonMark(raw);
  const chunks = splitOnBlockBoundaries(converted || ' ', MRKDWN_CHUNK);
  return chunks.map((chunk) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: chunk.length ? chunk : ' ' }
  }));
}

/**
 * HTML mode: render Markdown then sanitize against an explicit allowlist.
 * @param {string} raw
 * @param {{ allowRemoteImages?: boolean }} [opts]
 * @returns {string} a standalone HTML document
 */
export function toHtml(raw, opts = {}) {
  const allowRemoteImages = opts.allowRemoteImages ?? ENV_ALLOW_REMOTE_IMAGES;
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const dirty = md.render(text); // html:false already escaped any raw HTML
  const clean = sanitizeHtml(dirty, sanitizeOptions(allowRemoteImages));
  return wrapHtmlDocument(clean);
}

/**
 * Build the sanitize-html allowlist options (§5.3).
 * @param {boolean} allowRemoteImages
 */
export function sanitizeOptions(allowRemoteImages) {
  return {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr', 'strong', 'em', 'del',
      'blockquote', 'ul', 'ol', 'li',
      'code', 'pre', 'a',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'input', 'img'
    ],
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'alt'],
      input: ['type', 'checked', 'disabled'],
      code: ['class'], // language-* highlight classes
      pre: ['class'],
      th: ['align'],
      td: ['align']
    },
    // Drop http: and data: to kill mixed-content and data-URI XSS (§5.3).
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesByTag: {},
    disallowedTagsMode: 'discard',
    // input only as a disabled task-list checkbox.
    transformTags: {
      img: imageTransform(allowRemoteImages),
      input: (tagName, attribs) => ({
        tagName: 'input',
        attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked ? { checked: 'checked' } : {}) }
      })
    }
  };
}

/**
 * Neutralize remote images by stripping `src` (keeping alt) unless explicitly allowed.
 * Prevents exfiltration beacons (§5.3).
 * @param {boolean} allowRemoteImages
 */
function imageTransform(allowRemoteImages) {
  return (tagName, attribs) => {
    if (allowRemoteImages) return { tagName: 'img', attribs };
    return { tagName: 'img', attribs: attribs.alt ? { alt: attribs.alt } : {} };
  };
}

/**
 * Wrap a sanitized fragment in a minimal standalone HTML document.
 * @param {string} fragment
 */
export function wrapHtmlDocument(fragment) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Rendered Markdown</title>',
    '</head>',
    '<body>',
    fragment,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;
const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Split text into chunks no larger than `chunkSize`, breaking only on blank-line
 * block boundaries that fall OUTSIDE a fenced code block. Oversized single blocks
 * are hard-split, re-opening the fence in the next chunk (§5.2).
 * @param {string} text
 * @param {number} chunkSize
 * @returns {string[]}
 */
export function splitOnBlockBoundaries(text, chunkSize) {
  if (text.length <= chunkSize) return [text];

  // 1. Group lines into blocks separated by blank lines outside fences.
  const lines = text.split('\n');
  const blocks = [];
  let buf = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_LINE_RE.test(line)) inFence = !inFence;
    buf.push(line);
    if (!inFence && line.trim() === '') {
      blocks.push(buf.join('\n'));
      buf = [];
    }
  }
  if (buf.length) blocks.push(buf.join('\n'));

  // 2. Greedily combine blocks into chunks; hard-split any oversized block.
  const chunks = [];
  let cur = '';
  for (const block of blocks) {
    if (block.length > chunkSize) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (const piece of hardSplitBlock(block, chunkSize)) chunks.push(piece);
      continue;
    }
    const candidate = cur ? cur + '\n' + block : block;
    if (candidate.length > chunkSize) {
      if (cur) chunks.push(cur);
      cur = block;
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Hard-split a single oversized block. If it is a fenced code block, close and
 * re-open the fence around each piece so no chunk contains an unterminated fence.
 * @param {string} block
 * @param {number} chunkSize
 * @returns {string[]}
 */
function hardSplitBlock(block, chunkSize) {
  const lines = block.split('\n');
  const open = lines[0].match(FENCE_OPEN_RE);
  const out = [];

  if (open) {
    const indent = open[1];
    const marker = open[2];
    const info = open[3];
    const openLine = indent + marker + info;
    const closeLine = indent + marker;

    let bodyLines = lines.slice(1);
    if (bodyLines.length && FENCE_LINE_RE.test(bodyLines[bodyLines.length - 1])) {
      bodyLines = bodyLines.slice(0, -1); // drop original closing fence
    }

    let cur = openLine;
    for (const bl of bodyLines) {
      const candidate = cur + '\n' + bl;
      if ((candidate + '\n' + closeLine).length > chunkSize && cur !== openLine) {
        out.push(cur + '\n' + closeLine);
        cur = openLine + '\n' + bl;
      } else {
        cur = candidate;
      }
    }
    out.push(cur + '\n' + closeLine);
    return out;
  }

  // Not a fence: split on line boundaries; char-split any monster line.
  let cur = '';
  for (const line of lines) {
    if (line.length > chunkSize) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += chunkSize) {
        out.push(line.slice(i, i + chunkSize));
      }
      continue;
    }
    const candidate = cur ? cur + '\n' + line : line;
    if (candidate.length > chunkSize && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}
