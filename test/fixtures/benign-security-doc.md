# Understanding Prompt Injection

Prompt injection is a class of attack against LLM-backed systems. An attacker
embeds text intended to change how a downstream model behaves. Defenders should
understand the category without reproducing working payloads.

## Common framings

Some jailbreak attempts reference a so-called "developer mode" to imply the model
has fewer restrictions. Recognizing this framing helps reviewers spot suspicious
content. Documentation that merely names these concepts is not itself an attack.

## Mitigations

- Treat model output as untrusted.
- Normalize input before scanning.
- Keep a human in the loop for high-impact actions.
