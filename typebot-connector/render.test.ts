import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedResponse } from './typebot-types.ts';
import { renderResponse } from './render.ts';

test('renders text (markdown→WA), media, and a numbered choice list', () => {
  const resp: NormalizedResponse = {
    bubbles: [
      { kind: 'text', markdown: '**Hi**' },
      { kind: 'image', url: 'https://x/i.png' },
    ],
    input: { kind: 'choice', blockId: 'b', multiple: false, items: [
      { id: '1', content: 'Sales' }, { id: '2', content: 'Support' },
    ] },
  };
  assert.deepEqual(renderResponse(resp), [
    { type: 'text', text: '*Hi*' },
    // media carries mediaUrl for hosts that support it + text (the URL) as a fallback for text-only hosts
    { type: 'image', mediaUrl: 'https://x/i.png', text: 'https://x/i.png' },
    { type: 'text', text: '1. Sales\n2. Support' },
  ]);
});

test('rating prompt, redirect URL, and flow-end (no input) render correctly', () => {
  assert.deepEqual(
    renderResponse({ bubbles: [], input: { kind: 'rating', blockId: 'b', max: 5 } }),
    [{ type: 'text', text: 'Reply with a number from 1 to 5.' }],
  );
  assert.deepEqual(
    renderResponse({ bubbles: [{ kind: 'text', markdown: 'Bye' }], redirectUrl: 'https://x/done' }),
    [{ type: 'text', text: 'Bye' }, { type: 'text', text: 'https://x/done' }],
  );
  assert.deepEqual(renderResponse({ bubbles: [{ kind: 'link', url: 'https://x/e' }] }), [
    { type: 'text', text: 'https://x/e' },
  ]);
});

test('multi-choice appends a hint; unsupported input has a fallback line', () => {
  const multi = renderResponse({ bubbles: [], input: { kind: 'choice', blockId: 'b', multiple: true, items: [{ id: '1', content: 'A' }] } });
  assert.match(multi[0].type === 'text' ? multi[0].text : '', /pick more than one/);
  const unsupported = renderResponse({ bubbles: [], input: { kind: 'unsupported', blockId: 'b', typeLabel: 'payment input' } });
  assert.match(unsupported[0].type === 'text' ? unsupported[0].text : '', /can't be shown on WhatsApp/);
});
