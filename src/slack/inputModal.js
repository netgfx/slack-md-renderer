/**
 * @file Paste-path input modal for /render (§4 entry point 2). A modal preserves
 * the raw multi-line Markdown exactly, which pasting into a channel would mangle.
 * The preview is Markdown-only; there is no output-mode choice anymore.
 */

export const RENDER_CALLBACK_ID = 'render_modal';

export const BLOCK_IDS = {
  source: 'src_block',
  instruction: 'instruction_block'
};

export const ACTION_IDS = {
  source: 'markdown_source',
  instruction: 'instruction_file'
};

export const INSTRUCTION_VALUE = 'instruction';

const instructionOption = {
  text: { type: 'plain_text', text: 'This is an AI instruction/skill file' },
  description: {
    type: 'plain_text',
    text: 'Runs the audit in strict mode and hides the HTML download.'
  },
  value: INSTRUCTION_VALUE
};

/**
 * Build the /render paste modal view.
 * @returns {object} a Slack `modal` view payload
 */
export function buildInputModal() {
  return {
    type: 'modal',
    callback_id: RENDER_CALLBACK_ID,
    title: { type: 'plain_text', text: 'Render Markdown' },
    submit: { type: 'plain_text', text: 'Render' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: BLOCK_IDS.source,
        label: { type: 'plain_text', text: 'Markdown source' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_IDS.source,
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Paste raw Markdown here…' }
        }
      },
      {
        type: 'input',
        block_id: BLOCK_IDS.instruction,
        optional: true,
        label: { type: 'plain_text', text: 'Type' },
        element: {
          type: 'checkboxes',
          action_id: ACTION_IDS.instruction,
          options: [instructionOption] // default OFF (§4 input modal fields)
        }
      }
    ]
  };
}

/**
 * Extract submitted values from a view_submission payload.
 * @param {object} view the `view` object from the payload
 * @returns {{ source: string, instructionFile: boolean }}
 */
export function parseSubmission(view) {
  const values = view?.state?.values ?? {};
  const source = values[BLOCK_IDS.source]?.[ACTION_IDS.source]?.value ?? '';
  const selected = values[BLOCK_IDS.instruction]?.[ACTION_IDS.instruction]?.selected_options ?? [];
  const instructionFile = selected.some((o) => o.value === INSTRUCTION_VALUE);
  return { source, instructionFile };
}
