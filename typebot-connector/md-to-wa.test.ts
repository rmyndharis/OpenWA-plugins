import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdToWhatsApp } from './md-to-wa.ts';

test('converts bold, italic, strike, code, links, headings', () => {
  assert.equal(mdToWhatsApp('**bold**'), '*bold*');
  assert.equal(mdToWhatsApp('__bold__'), '*bold*');
  assert.equal(mdToWhatsApp('*italic*'), '_italic_');
  assert.equal(mdToWhatsApp('~~strike~~'), '~strike~');
  assert.equal(mdToWhatsApp('use `code` here'), 'use code here');
  assert.equal(mdToWhatsApp('[Docs](https://x.io)'), 'Docs (https://x.io)');
  assert.equal(mdToWhatsApp('# Title'), 'Title');
});

test('mixed line and plain text are preserved', () => {
  assert.equal(mdToWhatsApp('**A** and *b* and ~~c~~'), '*A* and _b_ and ~c~');
  assert.equal(mdToWhatsApp('nothing special'), 'nothing special');
});
