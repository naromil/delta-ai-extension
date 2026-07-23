// Ported from ref_src/shared/prompts.ts — kept verbatim in spirit.

export const LOOKUP_SYSTEM_PROMPT = [
  'You are Delta AI, a helpful assistant in the software\'s lookup window.',
  'You will help the user approach something they are not familiar with conveniently and effectively.',
  'The context will be extracted from the screen (often via OCR), and the user will ask you to analyze it or answer questions about it.',
  "Always use web search to answer the user's questions if the answer cannot be determined from the context.",
  'If the context is extracted via OCR, it may contain errors; ask for clarification when necessary, but do not mention about OCR.',
  'Answer in simple and concise words.'
].join(' ');

export const CHAT_SYSTEM_PROMPT = ['You are Delta AI, a helpful assistant in the software\'s chat window.'].join(' ');

export function getSystemPrompt(role) {
  return role === 'lookup' ? LOOKUP_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT;
}

export const ANSWER_FALLBACK = '(empty answer)';
export const EXPAND_DEFAULT_PROMPT = 'more';

export function buildExpandUserInstruction(selection) {
  const EXPAND_SHARED_CONSTRAINTS = [
    'Do NOT repeat the word itself or re-state the sentence it appears in.',
    'Keep it concise, but provide enough detail to be helpful. Respond in inline text only.'
  ];
  const EXPAND_DEFINE_CONSTRAINTS = [
    'Do NOT use phrases like "refers to" or "is" that introduce the word.',
    'Output just the definition — a bare phrase or noun phrase.',
    'Example good output for "HKUMed": Li Ka Shing Faculty of Medicine at the University of Hong Kong',
    'Example bad output: "HKUMed" refers to the Li Ka Shing Faculty of Medicine...'
  ];
  return [`The user wants to define "${selection}" from the text above.`, ...EXPAND_SHARED_CONSTRAINTS, ...EXPAND_DEFINE_CONSTRAINTS].join(' ');
}

export function buildExpandPromptedInstruction(selection, prompt) {
  const verb = (prompt || '').trim() || EXPAND_DEFAULT_PROMPT;
  const EXPAND_SHARED_CONSTRAINTS = [
    'Do NOT repeat the word itself or re-state the sentence it appears in.',
    'Keep it concise, but provide enough detail to be helpful. Respond in inline text only.'
  ];
  return [`The user wants to know "${verb}" about "${selection}" from the text above.`, ...EXPAND_SHARED_CONSTRAINTS].join(' ');
}
