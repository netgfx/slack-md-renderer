import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyMarkdown, extractFrontMatterKeys } from '../src/classify.js';

// ---------------------------------------------------------------------------
// Filename / path -> instruction (strict, NO html export)
// ---------------------------------------------------------------------------

for (const filename of ['SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'foo.mdc', '.cursorrules']) {
  test(`${filename} classifies as instruction`, () => {
    const res = classifyMarkdown({ filename, raw: '# hi' });
    assert.equal(res.kind, 'instruction');
    assert.equal(res.strict, true);
    assert.equal(res.allowHtmlExport, false);
  });
}

test('path segment skills/ marks instruction', () => {
  const res = classifyMarkdown({ filename: 'skills/my-skill/notes.md', raw: '# hi' });
  assert.equal(res.kind, 'instruction');
});

test('.github/*instructions* marks instruction', () => {
  const res = classifyMarkdown({ filename: '.github/copilot-instructions.md', raw: '# hi' });
  assert.equal(res.kind, 'instruction');
});

// ---------------------------------------------------------------------------
// Front-matter -> instruction even with a generic filename
// ---------------------------------------------------------------------------

test('front-matter name+description marks instruction (generic filename)', () => {
  const raw = '---\nname: summarizer\ndescription: Summarizes text.\n---\n\n# Body';
  const res = classifyMarkdown({ filename: 'notes.md', raw });
  assert.equal(res.kind, 'instruction');
  assert.equal(res.allowHtmlExport, false);
});

test('front-matter tools: marks instruction', () => {
  const raw = '---\ntools: [search]\n---\n\n# Body';
  const res = classifyMarkdown({ filename: 'whatever.md', raw });
  assert.equal(res.kind, 'instruction');
});

// ---------------------------------------------------------------------------
// document -> html export allowed
// ---------------------------------------------------------------------------

for (const filename of ['README.md', 'notes.md', 'docs/guide.markdown']) {
  test(`${filename} classifies as document`, () => {
    const res = classifyMarkdown({ filename, raw: '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
    assert.equal(res.kind, 'document');
    assert.equal(res.strict, false);
    assert.equal(res.allowHtmlExport, true);
  });
}

test('plain markdown with no front-matter is a document', () => {
  const res = classifyMarkdown({ filename: '', raw: '# Just a doc\n\nText.' });
  assert.equal(res.kind, 'document');
});

test('forceInstruction (paste checkbox) overrides to instruction', () => {
  const res = classifyMarkdown({ filename: '', raw: '# doc', forceInstruction: true });
  assert.equal(res.kind, 'instruction');
  assert.equal(res.allowHtmlExport, false);
  assert.ok(res.reasons.length > 0);
});

// ---------------------------------------------------------------------------
// front-matter parser unit
// ---------------------------------------------------------------------------

test('extractFrontMatterKeys returns null without front-matter', () => {
  assert.equal(extractFrontMatterKeys('# no front matter'), null);
});

test('extractFrontMatterKeys reads top-level keys only', () => {
  const keys = extractFrontMatterKeys('---\nname: x\ndescription: y\n  nested: z\n---\nbody');
  assert.ok(keys.has('name'));
  assert.ok(keys.has('description'));
  assert.ok(!keys.has('nested'));
});
