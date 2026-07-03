import type { NormalizedResponse, InputSpec, OutgoingPart } from './typebot-types.ts';
import { mdToWhatsApp } from './md-to-wa.ts';

// Turn a normalized Typebot response into ordered WhatsApp parts. turn.ts fills in sessionId/chatId/replyTo.
export function renderResponse(resp: NormalizedResponse): OutgoingPart[] {
  const parts: OutgoingPart[] = [];
  for (const b of resp.bubbles) {
    if (b.kind === 'text') parts.push({ type: 'text', text: mdToWhatsApp(b.markdown) });
    else if (b.kind === 'link') parts.push({ type: 'text', text: b.url });
    // Belt-and-suspenders: OpenWA 0.8.x send() ignores mediaUrl and would deliver an empty message, so carry
    // the URL as text too. A host that wires mediaUrl sends native media; on 0.8.x the user still gets the link.
    else parts.push({ type: b.kind, mediaUrl: b.url, text: b.url });
  }
  if (resp.input) {
    const prompt = renderInputPrompt(resp.input);
    if (prompt) parts.push(prompt);
  }
  if (resp.redirectUrl) parts.push({ type: 'text', text: resp.redirectUrl });
  return parts;
}

function renderInputPrompt(input: InputSpec): OutgoingPart | null {
  switch (input.kind) {
    case 'choice': {
      const lines = input.items.map((it, i) => `${i + 1}. ${it.content}`).join('\n');
      const hint = input.multiple ? '\n\n(You can pick more than one, separated by commas.)' : '';
      return { type: 'text', text: lines + hint };
    }
    case 'rating':
      return { type: 'text', text: `Reply with a number${input.max ? ` from 1 to ${input.max}` : ''}.` };
    case 'file':
      return { type: 'text', text: 'Send a file or photo — or type your answer to continue.' };
    case 'text':
      return input.placeholder ? { type: 'text', text: input.placeholder } : null;
    case 'unsupported':
      return { type: 'text', text: `This step (${input.typeLabel}) can't be shown on WhatsApp.` };
  }
}
