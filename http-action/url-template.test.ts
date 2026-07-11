import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderText, renderPath, renderJson, renderHeader, getPath } from './url-template.ts';

const ctx = (over: Record<string, unknown> = {}) => ({
  args: ['INV-001'],
  response: { orderId: 'INV-001', status: 'shipped', trackingNumber: 'JNE123', items: [{ name: 'Widget' }] },
  ...over,
});

// ---- renderText: reply / error / notFound templates ----

test('renderText substitutes a top-level response path', () => {
  assert.equal(renderText('Status: {{response.status}}', ctx()), 'Status: shipped');
});

test('renderText substitutes a nested path into a primitive', () => {
  assert.equal(renderText('{{response.items.0.name}}', ctx()), 'Widget');
});

test('renderText substitutes several placeholders in one template', () => {
  assert.equal(renderText('{{response.orderId}} -> {{response.status}}', ctx()), 'INV-001 -> shipped');
});

test('renderText: a missing value renders as empty string', () => {
  assert.equal(renderText('[{{response.unknown}}]', ctx()), '[]');
});

test('renderText: literal text without placeholders passes through unchanged', () => {
  assert.equal(renderText('no placeholders here', ctx()), 'no placeholders here');
});

test('renderText: substitutes args.N', () => {
  assert.equal(renderText('arg0={{args.0}}', ctx()), 'arg0=INV-001');
});

// ---- prototype pollution defense (the core security property) ----

test('renderText rejects __proto__ in the path', () => {
  assert.throws(() => renderText('{{__proto__.x}}', ctx()), /prototype|__proto__/i);
});

test('renderText rejects constructor / prototype keys anywhere in the path', () => {
  assert.throws(() => renderText('{{response.constructor}}', ctx()), /prototype|constructor/i);
  assert.throws(() => renderText('{{a.constructor.prototype}}', ctx()), /prototype|constructor/i);
});

// ---- depth + count caps (DoS bound) ----

test('renderText rejects a path deeper than the cap', () => {
  const deep = 'a' + '.a'.repeat(20);
  assert.throws(() => renderText(`{{${deep}}}`, ctx()), /depth|too deep|long/i);
});

test('renderText rejects a template with too many placeholders', () => {
  const many = '{{response.status}} '.repeat(200);
  assert.throws(() => renderText(many, ctx()), /too many|count|placeholder/i);
});

// ---- renderPath: URL-encoded segments (SSRF / path-injection defense) ----

test('renderPath encodes a substituted segment value', () => {
  assert.equal(renderPath('/orders/{{args.0}}', ctx({ args: ['INV 001'] })), '/orders/INV%20001');
});

test('renderPath encodes an embedded slash so an arg cannot add a path segment', () => {
  assert.equal(renderPath('/orders/{{args.0}}', ctx({ args: ['a/b'] })), '/orders/a%2Fb');
});

test('renderPath leaves literal path structure intact', () => {
  assert.equal(renderPath('/orders/{{args.0}}/items', ctx({ args: ['X'] })), '/orders/X/items');
});

test('renderPath is prototype-safe', () => {
  assert.throws(() => renderPath('/x/{{__proto__.y}}', ctx()), /prototype|__proto__/i);
});

// ---- renderJson: POST body, JSON-safe substitution ----

test('renderJson substitutes a value into a JSON string field with safe escaping', () => {
  const out = renderJson('{"q":"{{args.0}}"}', ctx({ args: ['x"y'] }));
  assert.equal(out, '{"q":"x\\"y"}');
  assert.deepEqual(JSON.parse(out), { q: 'x"y' }); // re-parses cleanly
});

test('renderJson escapes backslashes', () => {
  const out = renderJson('{"q":"{{args.0}}"}', ctx({ args: ['a\\b'] }));
  assert.deepEqual(JSON.parse(out), { q: 'a\\b' });
});

test('renderJson is prototype-safe', () => {
  assert.throws(() => renderJson('{{__proto__.x}}', ctx()), /prototype|__proto__/i);
});

test('renderJson returns a valid JSON string for a plain value', () => {
  const out = renderJson('{"code":"{{args.0}}"}', ctx({ args: ['INV-001'] }));
  assert.deepEqual(JSON.parse(out), { code: 'INV-001' });
});

// ---- getPath: the shared prototype-safe walker ----

test('getPath walks a dotted path and returns the value', () => {
  assert.equal(getPath({ a: { b: { c: 5 } } }, 'a.b.c'), 5);
});

test('getPath returns undefined for a missing path (no throw)', () => {
  assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined);
});

test('getPath rejects a prototype key segment', () => {
  assert.throws(() => getPath({}, '__proto__'), /prototype|__proto__/i);
  assert.throws(() => getPath({ a: {} }, 'a.constructor'), /prototype|constructor/i);
});

// ---- renderPath: '..' traversal block ----

test('renderPath rejects a ".." segment (same-origin traversal blocked)', () => {
  assert.throws(() => renderPath('/orders/{{args.0}}', { args: ['..'] }), /traversal|\.\./i);
  assert.throws(() => renderPath('/orders/{{args.0}}', { args: ['../..'] }), /traversal|\.\./i);
});

test('renderPath keeps benign dotted values (version numbers, no "..")', () => {
  assert.equal(renderPath('/v/{{args.0}}', { args: ['1.0.3'] }), '/v/1.0.3');
});

// ---- renderHeader: CR/LF/NUL injection block ----

test('renderHeader rejects a rendered value containing CR/LF (header injection blocked)', () => {
  assert.throws(() => renderHeader('{{args.0}}', { args: ['a\nb'] }), /CR\/LF|header/i);
  assert.throws(() => renderHeader('{{args.0}}', { args: ['a\r\nInjected: x'] }), /CR\/LF|header/i);
});

test('renderHeader accepts a clean value', () => {
  assert.equal(renderHeader('X-Trace: {{message.id}}', { args: [], message: { id: 'm1' } }), 'X-Trace: m1');
});
