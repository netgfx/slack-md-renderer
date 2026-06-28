# slack-md-renderer

A small Slack app for non-technical users that renders Markdown **safely**. The
primary flow is a **"Render Markdown" message shortcut** on a shared `.md` file:
one click opens a modal showing the rendered Markdown. Document (non-instruction)
files also get a **"Download as HTML"** button that DMs you a sanitized HTML file.

Everything is gated by a **deterministic security audit** — no LLM is involved at
render or audit time. If the audit finds prompt-injection, hidden content, or other
malicious patterns, the app **refuses to render** and shows the findings instead.

## Why an audit if no LLM renders?

The renderer can't be "jailbroken", but the *source* and *output* are dangerous
downstream: hidden HTML comments / zero-width / Unicode-Tag characters deceive a
human reviewer; instruction-override and exfiltration payloads poison a later agent;
remote images are exfiltration beacons; and the HTML file must not carry script.
See [docs/slack-markdown-renderer-plan.md](docs/slack-markdown-renderer-plan.md) §1.

## How it works

```
entry point ─┐
 1. message shortcut "Render Markdown"  (PRIMARY)
 2. /render slash command (paste path)            ┌─> classify ─> audit ─> render
 3. file_shared: auto-render or button (opt-in) ──┘        │
                                                            ├─ blocked → warning (findings)
                                                            └─ safe    → preview / threaded reply
                                                                          (+ "Download as HTML"
                                                                           for document files)
```

Entry points 1–2 open a **modal** preview (Slack `mrkdwn`, no tables). Entry point 3
(`file_shared`, opt-in) has no `trigger_id`, so it delivers as a **message** — which
supports the native `markdown` block, so the auto-render path renders **full fidelity
including tables**.

- **Classifier** (`src/classify.js`): instruction/skill file vs document. Instruction
  files (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `*.mdc`, `.cursorrules`, front-matter
  with `name:`+`description:` or `tools:`, paths under `skills/` / `.claude/`, …) are
  audited in **strict mode** and get **no HTML export** (rendering a skill file to HTML
  would hide the very comments/invisibles a reviewer needs to see).
- **Audit** (`src/security/`): invisible-character scan on the original bytes →
  NFKC-normalized copy → deterministic regex ruleset (`config/ruleset.json`) →
  severity→action mapping. Strict mode blocks on MEDIUM+; normal mode blocks on HIGH+
  and renders MEDIUM with a caution banner.
- **Render** (`src/render.js`): `markdown-it` runs with `html:false` (raw HTML is
  escaped, never emitted). Preview uses native Slack `markdown` blocks with an
  automatic `section`+`mrkdwn` fallback. HTML export is sanitized with `sanitize-html`
  (allowlist; `https`/`mailto` schemes only; remote image `src` stripped by default).

### Modal Markdown fidelity (confirmed)

Slack's `markdown` block is **not supported inside modal views** — sending one makes
`views.open`/`views.update` fail with `invalid_arguments`. Modals only accept `mrkdwn`
text objects in `section` blocks. So the modal preview converts CommonMark to Slack
`mrkdwn` (`mrkdwnFromCommonMark` in [src/render.js](src/render.js)): headings render as
bold, `**bold**`→`*bold*`, links as `<url|text>`, bullets as `•`, and fenced/inline code
is preserved verbatim. **Tables and sized headers don't render in `mrkdwn`** — use the
**Download as HTML** button for full-fidelity output (documents only).

## Project layout

```
src/
  app.js                # Bolt wiring: shortcut, /render, actions, file_shared
  classify.js           # instruction vs document
  render.js             # toSlackBlocks / toMrkdwnSections / toHtml
  deliver.js            # fetchFileText, dmHtmlFile, postCompanionButton
  previewCache.js       # short-lived audited-source cache (download reuse)
  security/             # audit.js, normalize.js, ruleset.js
  slack/                # inputModal, previewView, warningView, fileEntry
config/
  ruleset.json          # detection patterns (versioned)
  classify.json         # filename/front-matter classifier patterns
test/                   # node:test suites + fixtures
```

## Local development

```bash
npm ci
cp .env.example .env     # fill in SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET
npm run lint
npm test
npm start                # binds to PORT (default 3000), serves POST /slack/events
```

Slack must reach a public HTTPS URL. For local testing, tunnel (e.g. `ngrok http 3000`)
and use the tunnel URL as the Request URL.

## Slack app setup

1. **api.slack.com/apps → Create New App → From scratch**, pick the workspace.
2. **OAuth & Permissions → Bot Token Scopes**: `commands`, `chat:write`, `files:read`,
   `files:write`, `im:write`.
3. **Slash Commands → Create New Command**: `/render`, Request URL
   `https://<service>.onrender.com/slack/events`.
4. **Interactivity & Shortcuts**: toggle ON, set the same Request URL. Then
   **Shortcuts → Create New Shortcut → On messages**: name "Render Markdown",
   callback id **`render_md_msg`**.
5. *(Optional, auto-render / companion button)* **Event Subscriptions**: enable, same
   Request URL, subscribe to the **bot event** `file_shared`. Then set
   `FILE_SHARED_MODE` (`auto` or `button`) and `FILE_RENDER_CHANNELS` to the channel
   IDs, and invite the app to those channels. `auto` posts the rendered Markdown as a
   threaded reply (full fidelity, tables included) whenever a `.md` is shared.
6. **Basic Information**: copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.
   **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-…`) →
   `SLACK_BOT_TOKEN`.
7. Confirm Request URLs show **Verified** under Slash Commands, Interactivity, and
   (if used) Event Subscriptions.

## Deploy on Render.com

- Web Service (Node). Build `npm ci`, Start `npm start`. Bind to `process.env.PORT`.
- Env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ALLOW_REMOTE_IMAGES` (default
  `false`), `FILE_SHARED_MODE` + `FILE_RENDER_CHANNELS` (optional), `NODE_VERSION=22`.
  See [render.yaml](render.yaml).
- **Cold-start caveat:** Slack requires the Request URL to ack within **3 seconds**.
  Render free instances spin down and cold starts can exceed that. Use at least the
  cheapest **always-on** (`starter`) plan, or add an external uptime ping.

## Security configuration knobs

| Env | Default | Effect |
|---|---|---|
| `ALLOW_REMOTE_IMAGES` | `false` | `false` strips remote `<img src>` in HTML export (anti-exfil) |
| `FILE_SHARED_MODE` | `off` | `auto` = auto-render a threaded reply on share; `button` = post a Render button |
| `FILE_RENDER_CHANNELS` | empty | channel IDs where `file_shared` handling is active (empty = off) |

Hard limits: input is rejected over **50,000 chars**; shared files over **256 KB** are
refused. Audit rules live in `config/ruleset.json` and are unit-tested against attack
and benign fixtures in `test/`.

## Tests

`node:test` (no Jest). `npm test` covers: audit blocking/allowing per §9 fixtures,
classifier behavior, HTML sanitization (script/`onerror`/`javascript:`/`data:` all
neutralized), Slack chunking (never splits a fenced block), the mrkdwn fallback, and
the download/DM flow with a mocked client.
