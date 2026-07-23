// Ported from ref_src/shared/expand-prompt.ts.
import { ANSWER_FALLBACK, buildExpandUserInstruction, buildExpandPromptedInstruction } from './prompts.js';

export function buildExpandMessages(input) {
  const { answer, selection, prompt } = input;
  const messages = [];
  messages.push({ role: 'assistant', content: answer || ANSWER_FALLBACK });
  messages.push({
    role: 'user',
    content:
      prompt !== undefined
        ? buildExpandPromptedInstruction(selection, prompt)
        : buildExpandUserInstruction(selection)
  });
  return messages;
}
