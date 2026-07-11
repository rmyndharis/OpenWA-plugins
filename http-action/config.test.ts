import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, isDangerousHeader, isAllowedMethod, validatePath } from './config.ts';

const validActions = JSON.stringify([
  {
    id: 'check-order',
    match: { type: 'prefix', value: 'cek-order ' },
    request: { method: 'GET', path: '/orders/{{args.0}}' },
    replyTemplate: 'Pesanan {{response.orderId}}: {{response.status}}',
  },
]);

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseUrl: 'https://erp.example.com',
  actions: validActions,
  ...over,
});

test('happy path: parses a valid config and applies defaults', () => {
  const cfg = readConfig(base());
  assert.equal(cfg.baseUrl, 'https://erp.example.com');
  assert.equal(cfg.authType, 'none');
  assert.equal(cfg.respondInGroups, false);
  assert.equal(cfg.timeoutMs, 3000);
  assert.equal(cfg.cooldownSeconds, 3);
  assert.equal(cfg.apiKeyHeader, 'X-API-Key');
  assert.equal(cfg.actions.length, 1);
  assert.equal(cfg.actions[0].match.caseSensitive, false);
});

test('baseUrl: trailing slash is stripped', () => {
  assert.equal(readConfig(base({ baseUrl: 'https://erp.example.com/' })).baseUrl, 'https://erp.example.com');
});

test('baseUrl: required (empty rejected — allowConfigHosts, no code default)', () => {
  assert.throws(() => readConfig(base({ baseUrl: '' })), /baseUrl: is required/);
  assert.throws(() => readConfig(base({ baseUrl: '   ' })), /baseUrl: is required/);
});

test('baseUrl: must be a URL', () => {
  assert.throws(() => readConfig(base({ baseUrl: 'not a url' })), /baseUrl: must be a valid URL/);
});

test('baseUrl: must be https', () => {
  assert.throws(() => readConfig(base({ baseUrl: 'http://erp.example.com' })), /baseUrl: must be https/);
});

test('baseUrl: no embedded credentials', () => {
  assert.throws(() => readConfig(base({ baseUrl: 'https://user:pass@erp.example.com' })), /embedded credentials/);
});

test('baseUrl: no fragment', () => {
  assert.throws(() => readConfig(base({ baseUrl: 'https://erp.example.com#x' })), /fragment/);
});

test('baseUrl: no query string (origin/path only)', () => {
  assert.throws(() => readConfig(base({ baseUrl: 'https://erp.example.com/api?key=ABC' })), /query string/);
});

test('apiKeyHeader: reserved/dangerous header name rejected', () => {
  assert.throws(() => readConfig(base({ authType: 'apikey', authToken: 'k', apiKeyHeader: 'Host' })), /reserved\/dangerous/);
  assert.throws(() => readConfig(base({ authType: 'apikey', authToken: 'k', apiKeyHeader: 'X-Forwarded-For' })), /reserved\/dangerous/);
});

test('auth: bearer/apikey require authToken', () => {
  assert.throws(() => readConfig(base({ authType: 'bearer' })), /authToken: is required/);
  assert.throws(() => readConfig(base({ authType: 'apikey' })), /authToken: is required/);
  const cfg = readConfig(base({ authType: 'bearer', authToken: 'tok' }));
  assert.equal(cfg.authType, 'bearer');
  assert.equal(cfg.authToken, 'tok');
});

test('actions: required (empty JSON string rejected)', () => {
  assert.throws(() => readConfig(base({ actions: '' })), /actions: is required/);
  assert.throws(() => readConfig(base({ actions: '   ' })), /actions: is required/);
});

test('actions: malformed JSON rejected', () => {
  assert.throws(() => readConfig(base({ actions: '{not json' })), /actions: JSON parse failed/);
});

test('actions: must be an array', () => {
  assert.throws(() => readConfig(base({ actions: JSON.stringify({ id: 'x' }) })), /actions: must be a JSON array/);
});

test('actions: at least one', () => {
  assert.throws(() => readConfig(base({ actions: '[]' })), /at least one action/);
});

test('actions: at most 25', () => {
  const many = Array.from({ length: 26 }, (_, i) => ({
    id: `a${i}`, match: { type: 'exact', value: `v${i}` },
    request: { method: 'GET', path: '/x' }, replyTemplate: 'r',
  }));
  assert.throws(() => readConfig(base({ actions: JSON.stringify(many) })), /at most 25/);
});

test('actions: accepts a pre-parsed array (not only a JSON string)', () => {
  const cfg = readConfig(base({ actions: [{ id: 'x', match: { type: 'exact', value: 'hi' }, request: { method: 'GET', path: '/x' }, replyTemplate: 'r' }] }));
  assert.equal(cfg.actions[0].id, 'x');
});

test('action.id: required + safe charset', () => {
  const bad = (id: string) => [{ id, match: { type: 'exact', value: 'v' }, request: { method: 'GET', path: '/x' }, replyTemplate: 'r' }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(bad('')) })), /id is required/);
  assert.throws(() => readConfig(base({ actions: JSON.stringify(bad('a b')) })), /id may only contain/);
  assert.throws(() => readConfig(base({ actions: JSON.stringify(bad('a/b')) })), /id may only contain/);
});

test('match: type enum + non-empty value', () => {
  const mk = (m: unknown) => [{ id: 'x', match: m, request: { method: 'GET', path: '/x' }, replyTemplate: 'r' }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(mk({ type: 'regex', value: 'v' })) })), /type must be/);
  assert.throws(() => readConfig(base({ actions: JSON.stringify(mk({ type: 'exact', value: '' })) })), /value is required/);
});

test('method: GET/POST only', () => {
  const mk = (method: string) => [{ id: 'x', match: { type: 'exact', value: 'v' }, request: { method, path: '/x' }, replyTemplate: 'r' }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(mk('DELETE')) })), /method must be/);
});

test('validatePath: protocol-relative // rejected', () => {
  assert.throws(() => validatePath('//evil.example/path', 'p'), /protocol-relative/);
});

test('validatePath: absolute URL rejected (no leading /)', () => {
  assert.throws(() => validatePath('https://evil.example/path', 'p'), /must be relative and start with \//);
});

test('validatePath: fragment rejected', () => {
  assert.throws(() => validatePath('/orders/x#frag', 'p'), /fragment/);
});

test('validatePath: control + null chars rejected', () => {
  assert.throws(() => validatePath('/orders/\tx', 'p'), /control\/null/);
  assert.throws(() => validatePath('/orders/\rx', 'p'), /control\/null/);
});

test('validatePath: a normal relative path with template placeholder is accepted', () => {
  assert.equal(validatePath('/orders/{{args.0}}', 'p'), '/orders/{{args.0}}');
});

test('headers: dangerous headers rejected (host, x-forwarded-*)', () => {
  const mk = (headers: Record<string, string>) => [{
    id: 'x', match: { type: 'exact', value: 'v' },
    request: { method: 'GET', path: '/x', headers }, replyTemplate: 'r',
  }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(mk({ Host: 'evil' })) })), /reserved\/dangerous/);
  assert.throws(() => readConfig(base({ actions: JSON.stringify(mk({ 'X-Forwarded-For': '1.2.3.4' })) })), /reserved\/dangerous/);
});

test('headers: CRLF rejected (header injection)', () => {
  const mk = (headers: Record<string, string>) => [{
    id: 'x', match: { type: 'exact', value: 'v' },
    request: { method: 'GET', path: '/x', headers }, replyTemplate: 'r',
  }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(mk({ 'X-Custom': 'a\r\nInjected: b' })) })), /CR\/LF/);
});

test('replyTemplate: required', () => {
  const bad = [{ id: 'x', match: { type: 'exact', value: 'v' }, request: { method: 'GET', path: '/x' } }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(bad) })), /replyTemplate is required/);
});

test('timeoutMs: below the 500 floor falls back to default 3000', () => {
  assert.equal(readConfig(base({ timeoutMs: 100 })).timeoutMs, 3000);
  assert.equal(readConfig(base({ timeoutMs: 'oops' })).timeoutMs, 3000);
});

test('request.bodyTemplate: optional, accepted as a JSON string', () => {
  const actions = [{
    id: 'x', match: { type: 'exact', value: 'v' },
    request: { method: 'POST', path: '/x', bodyTemplate: '{"q":"{{args.0}}"}' }, replyTemplate: 'r',
  }];
  const cfg = readConfig(base({ actions: JSON.stringify(actions) }));
  assert.equal(cfg.actions[0].request.bodyTemplate, '{"q":"{{args.0}}"}');
});

test('request.bodyTemplate: non-string rejected', () => {
  const actions = [{
    id: 'x', match: { type: 'exact', value: 'v' },
    request: { method: 'POST', path: '/x', bodyTemplate: 123 }, replyTemplate: 'r',
  }];
  assert.throws(() => readConfig(base({ actions: JSON.stringify(actions) })), /bodyTemplate/);
});

test('request.bodyTemplate: omitted → undefined (GET still valid)', () => {
  const cfg = readConfig(base()); // default validActions has no bodyTemplate
  assert.equal(cfg.actions[0].request.bodyTemplate, undefined);
});

test('isDangerousHeader + isAllowedMethod exports behave', () => {
  assert.equal(isDangerousHeader('Host'), true);
  assert.equal(isDangerousHeader('Authorization'), false); // plugin may set its own auth header
  assert.equal(isAllowedMethod('GET'), true);
  assert.equal(isAllowedMethod('PUT'), false);
});
