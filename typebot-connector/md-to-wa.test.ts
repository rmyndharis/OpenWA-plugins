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

test('a star or plus bullet stays a bullet and is never read as italic', () => {
  assert.equal(mdToWhatsApp('* item one\n* item two'), '- item one\n- item two');
  assert.equal(mdToWhatsApp('+ item'), '- item');
  assert.equal(mdToWhatsApp('  * nested'), '  - nested');
  assert.equal(mdToWhatsApp('* item with *italic* inside'), '- item with _italic_ inside');
});

test('italic never spans a line break', () => {
  assert.equal(mdToWhatsApp('a *b\nc* d'), 'a *b\nc* d');
});
