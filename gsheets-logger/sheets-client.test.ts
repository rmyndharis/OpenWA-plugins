import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildJwt, SheetsClient, type NetFetch } from './sheets-client.ts';

test('buildJwt produces a verifiable RS256 JWT with the right claims', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const jwt = buildJwt({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: pem }, 1_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.ok(h && c && sig, 'jwt has three segments');

  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.iss, 'svc@proj.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(claims.exp - claims.iat, 3600);

  const verified = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url');
  assert.ok(verified, 'signature verifies against the public key');
});

// ── SheetsClient over an injected NetFetch (sandbox contract: res.body string, no .json()) ──

const testSa = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
})();

interface FetchCall { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } }

function fakeFetch(handlers: Record<string, { status?: number; body: string }>) {
  const calls: FetchCall[] = [];
  const fn: NetFetch = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(handlers).find((k) => url.startsWith(k));
    const h = key ? handlers[key] : { status: 404, body: 'not found' };
    return { ok: (h.status ?? 200) < 400, status: h.status ?? 200, body: h.body };
  };
  return { calls, fn };
}

const TOKEN_OK = { body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) };

test('appendRows fetches a token once, caches it, and posts rows as a string body', async () => {
  const { calls, fn } = fakeFetch({
    'https://oauth2.googleapis.com/token': TOKEN_OK,
    'https://sheets.googleapis.com/': { body: '{}' },
  });
  const client = new SheetsClient(fn, testSa, 'SHEET1', 'Logs');
  await client.appendRows([['a', 'b']]);
  await client.appendRows([['c']]);

  const tokenCalls = calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com'));
  assert.equal(tokenCalls.length, 1, 'token is cached across appends');
  assert.equal(typeof tokenCalls[0].init?.body, 'string', 'form body must be a string (sandbox encodes UTF-8)');
  assert.match(tokenCalls[0].init?.body as string, /grant_type=urn/);
  assert.match(tokenCalls[0].init?.body as string, /assertion=/);

  const appends = calls.filter((c) => c.url.startsWith('https://sheets.googleapis.com'));
  assert.equal(appends.length, 2);
  assert.equal(appends[0].init?.headers?.authorization, 'Bearer tok-1');
  assert.match(appends[0].url, /spreadsheets\/SHEET1\/values\/Logs!A1:append/);
  assert.deepEqual(JSON.parse(appends[1].init?.body as string), { values: [['c']] });
});

test('a 401 clears the cached token so the next append re-authenticates', async () => {
  let appendAttempts = 0;
  const calls: FetchCall[] = [];
  const fn: NetFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com')) return { ok: true, status: 200, body: TOKEN_OK.body };
    appendAttempts++;
    return appendAttempts === 1
      ? { ok: false, status: 401, body: 'expired' }
      : { ok: true, status: 200, body: '{}' };
  };
  const client = new SheetsClient(fn, testSa, 'SHEET1', 'Logs');
  await assert.rejects(client.appendRows([['a']]), /Append failed: 401/);
  await client.appendRows([['a']]);
  assert.equal(calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com')).length, 2, 're-authenticated after 401');
});

test('a malformed token response throws instead of caching garbage', async () => {
  const { fn } = fakeFetch({ 'https://oauth2.googleapis.com/token': { body: '{"nope":true}' } });
  const client = new SheetsClient(fn, testSa, 'SHEET1', 'Logs');
  await assert.rejects(client.appendRows([['a']]), /missing access_token\/expires_in/);
});
