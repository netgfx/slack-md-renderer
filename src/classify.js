/**
 * @file File classifier (§4c): instruction/skill vs document. Deterministic, no LLM.
 * Drives (a) audit strictness and (b) whether the HTML download button is shown.
 *
 * classifyMarkdown({ filename, raw, forceInstruction }) ->
 *   { kind: 'instruction'|'document', strict: boolean, allowHtmlExport: boolean, reasons: string[] }
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'classify.json');

/** @type {any} */
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

/**
 * @param {{ filename?: string, raw?: string, forceInstruction?: boolean }} input
 * @returns {{ kind: string, strict: boolean, allowHtmlExport: boolean, reasons: string[] }}
 */
export function classifyMarkdown({ filename = '', raw = '', forceInstruction = false } = {}) {
  const reasons = [];

  if (forceInstruction) reasons.push('user marked as instruction file');

  const path = String(filename).toLowerCase().replace(/\\/g, '/');
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;

  if (base) {
    if (cfg.instructionFilenames.includes(base)) {
      reasons.push(`filename matches ${base}`);
    }
    for (const ext of cfg.instructionExtensions) {
      if (base.endsWith(ext)) reasons.push(`extension ${ext}`);
    }
    for (const suf of cfg.instructionSuffixes) {
      if (base.endsWith(suf)) reasons.push(`suffix ${suf}`);
    }
  }

  for (const seg of cfg.instructionPathSegments) {
    if (path.includes(seg)) reasons.push(`path contains ${seg}`);
  }

  const gh = cfg.githubInstructions;
  if (gh && path.includes(gh.segment) && base.includes(gh.nameContains)) {
    reasons.push(`${gh.segment} instructions file`);
  }

  for (const reason of frontMatterReasons(raw)) reasons.push(reason);

  const kind = reasons.length > 0 ? 'instruction' : 'document';
  return {
    kind,
    strict: kind === 'instruction',
    allowHtmlExport: kind === 'document',
    reasons
  };
}

/**
 * Inspect leading YAML front-matter for instruction-shaped keys.
 * @param {string} raw
 * @returns {string[]}
 */
function frontMatterReasons(raw) {
  const reasons = [];
  const keys = extractFrontMatterKeys(raw);
  if (!keys) return reasons;

  const [k1, k2] = cfg.frontMatter.requiredPair;
  if (keys.has(k1) && keys.has(k2)) {
    reasons.push(`front-matter has ${k1}+${k2} (SKILL shape)`);
  }
  for (const key of cfg.frontMatter.anyOf) {
    if (keys.has(key)) reasons.push(`front-matter has ${key}:`);
  }
  return reasons;
}

/**
 * Parse leading `---` … `---` front matter and return the set of top-level keys
 * (lowercased). Returns null when there is no front matter.
 * @param {string} raw
 * @returns {Set<string>|null}
 */
export function extractFrontMatterKeys(raw) {
  if (typeof raw !== 'string') return null;
  // Strip a leading BOM, then require an opening front-matter fence line.
  const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = s.match(/^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;

  const keys = new Set();
  for (const line of m[1].split(/\r?\n/)) {
    // Only top-level keys (no leading indentation).
    const km = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (km) keys.add(km[1].toLowerCase());
  }
  return keys;
}
