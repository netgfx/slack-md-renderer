/**
 * @file Loads and compiles config/ruleset.json into ready-to-run matchers.
 * Loaded once at module init; throws on a malformed rule so problems surface at
 * startup rather than at request time.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULESET_PATH = join(__dirname, '..', '..', 'config', 'ruleset.json');

/**
 * @typedef {Object} CompiledRule
 * @property {string} id
 * @property {string} category
 * @property {'low'|'medium'|'high'|'critical'} severity
 * @property {RegExp} regex
 * @property {RegExp|null} exclude
 * @property {boolean} strictOnly  only applies in strict mode
 * @property {string} description
 */

/**
 * @typedef {Object} Ruleset
 * @property {string} version
 * @property {CompiledRule[]} rules
 */

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Compile the JSON ruleset into RegExp-backed rules.
 * @param {string} [path] override path (used by tests)
 * @returns {Ruleset}
 */
export function loadRuleset(path = RULESET_PATH) {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.rules)) {
    throw new Error('ruleset.json: "rules" must be an array');
  }

  const rules = parsed.rules.map((rule, i) => {
    const where = `ruleset.json rule[${i}] (${rule.id ?? 'no-id'})`;
    if (!rule.id) throw new Error(`${where}: missing "id"`);
    if (!rule.category) throw new Error(`${where}: missing "category"`);
    if (!VALID_SEVERITIES.has(rule.severity)) {
      throw new Error(`${where}: invalid severity "${rule.severity}"`);
    }
    if (typeof rule.pattern !== 'string') {
      throw new Error(`${where}: "pattern" must be a string`);
    }

    let regex;
    try {
      regex = new RegExp(rule.pattern, rule.flags ?? '');
    } catch (err) {
      throw new Error(`${where}: bad pattern — ${err.message}`);
    }

    let exclude = null;
    if (rule.exclude) {
      try {
        exclude = new RegExp(rule.exclude, rule.excludeFlags ?? 'i');
      } catch (err) {
        throw new Error(`${where}: bad exclude — ${err.message}`);
      }
    }

    return {
      id: rule.id,
      category: rule.category,
      severity: rule.severity,
      regex,
      exclude,
      strictOnly: rule.strictOnly === true,
      description: rule.description ?? ''
    };
  });

  return { version: parsed.version ?? 'unknown', rules };
}

/** The default, process-wide compiled ruleset. */
export const ruleset = loadRuleset();
