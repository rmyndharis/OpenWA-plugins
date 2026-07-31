import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  IncomingMessage,
  PluginConversationsCapability,
  ConversationSendEnvelope,
  PluginStorage,
  PluginNetRequestInit,
  PluginNetResponse,
} from '../types/openwa';
import type { TypebotConfig } from './typebot-types.ts';
import { KeyedAsyncLock } from './chat-lock.ts';
import { SessionStore } from './session-store.ts';
import { TypebotClient } from './typebot-client.ts';
import { handleTurn } from './turn.ts';

// The REAL client is wired into the REAL turn handler; only the network and the WhatsApp send are faked.
// typebot-client.test.ts covers uploadFile in isolation and turn.test.ts covers the failure branch — the
// gap this file closes is the success path across the seam between them.

const cfg: TypebotConfig = {
  apiHost: 'https://typebot.io',
  publicId: 'bot',
  respondInGroups: true,
  sessionTimeoutMinutes: 30,
  passContactVariables: true,
};

// A PNG magic number: 8 bytes that are NOT valid UTF-8, so any accidental string round-trip corrupts them.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeStorage(): PluginStorage {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    delete: async k => void m.delete(k),
    list: async (p = '') => [...m.keys()].filter(k => k.startsWith(p)),
  };
}

const ok = (body: unknown): PluginNetResponse =>
  ({ ok: true, status: 200, headers: {}, body: JSON.stringify(body) }) as PluginNetResponse;
const noBody = (status: number): PluginNetResponse =>
  ({ ok: true, status, headers: {}, body: '' }) as PluginNetResponse;

function recorder(responses: PluginNetResponse[]) {
  const calls: { url: string; init?: PluginNetRequestInit }[] = [];
  let i = 0;
  const fetchFn = async (url: string, init?: PluginNetRequestInit) => {
    calls.push({ url, init });
    return responses[i++];
  };
  return { fetchFn, calls };
}

// Drive one turn: the bot is awaiting a file, the contact sends a PNG.
async function runFileTurn(responses: PluginNetResponse[]) {
  const { fetchFn, calls } = recorder(responses);
  const sent: ConversationSendEnvelope[] = [];
  const conversations: PluginConversationsCapability = { send: async e => void sent.push(e) };
  const store = new SessionStore(fakeStorage());
  await store.set('sess:c@c.us', {
    sessionId: 'S1',
    awaiting: { kind: 'file', blockId: 'blk' },
    lastActivity: 1000,
  });
  const msg = {
    id: 'm',
    from: 'c@c.us',
    to: 'me',
    chatId: 'c@c.us',
    body: '',
    type: 'image',
    timestamp: 0,
    fromMe: false,
    isGroup: false,
    media: { mimetype: 'image/png', filename: 'p.png', data: PNG.toString('base64') },
  } as IncomingMessage;

  await handleTurn(
    {
      cfg,
      client: new TypebotClient(fetchFn, cfg),
      store,
      lock: new KeyedAsyncLock(),
      conversations,
      now: () => 1000,
      log: () => {},
    },
    'sess',
    'Engine',
    msg,
  );
  return { calls, sent, store };
}

test('file input, proxy branch: PUT raw bytes, then continueChat carries the returned fileUrl', async () => {
  const { calls, sent, store } = await runFileTurn([
    ok({ presignedUrl: 'https://typebot.io/api/uploads/tok', formData: {}, fileUrl: 'https://cdn/p.png' }),
    noBody(200),
    ok({
      sessionId: 'S1',
      messages: [{ id: 'm2', type: 'text', content: { type: 'markdown', markdown: 'Got it' } }],
      input: { id: 'blk2', type: 'text input' },
    }),
  ]);

  // fileSize must be the DECODED byte length. Base64 inflates by 4/3, so a mix-up is silently accepted by
  // the type system and rejected by a real presigned URL whose policy pins content-length.
  assert.equal(calls[0].url, 'https://typebot.io/api/v3/generate-upload-url');
  const gu = JSON.parse(calls[0].init!.body as string);
  assert.equal(gu.fileSize, PNG.length);
  assert.notEqual(gu.fileSize, PNG.toString('base64').length);
  assert.equal(gu.sessionId, 'S1');
  assert.equal(gu.blockId, 'blk');
  assert.equal(gu.fileName, 'p.png');
  assert.equal(gu.fileType, 'image/png');

  // The bytes reach the presigned URL intact.
  assert.equal(calls[1].url, 'https://typebot.io/api/uploads/tok');
  assert.equal(calls[1].init!.method, 'PUT');
  assert.deepEqual(Buffer.from(calls[1].init!.body as Uint8Array), PNG);

  // continueChat carries fileUrl from generate-upload-url — NOT presignedUrl, which is single-use.
  assert.equal(calls[2].url, 'https://typebot.io/api/v1/sessions/S1/continueChat');
  const cont = JSON.parse(calls[2].init!.body as string);
  assert.deepEqual(cont.message, { type: 'text', text: '', attachedFileUrls: ['https://cdn/p.png'] });

  // The next prompt reaches WhatsApp and the advanced state is persisted.
  assert.deepEqual(sent.map(s => s.text), ['Got it']);
  assert.equal((await store.get('sess:c@c.us'))?.awaiting.blockId, 'blk2');
});

test('file input, S3 branch: multipart POST with every policy field before the file part', async () => {
  const { calls, sent } = await runFileTurn([
    ok({
      presignedUrl: 'https://s3.example/bucket',
      formData: { key: 'uploads/p.png', policy: 'POLICY', 'x-amz-signature': 'SIG' },
      fileUrl: 'https://cdn/s3.png',
    }),
    noBody(204),
    ok({
      sessionId: 'S1',
      messages: [{ id: 'm2', type: 'text', content: { type: 'markdown', markdown: 'Received' } }],
    }),
  ]);

  const post = calls[1];
  assert.equal(post.url, 'https://s3.example/bucket');
  assert.equal(post.init!.method, 'POST');

  // latin1 keeps one byte per character, so string offsets are byte offsets.
  const raw = Buffer.from(post.init!.body as Uint8Array);
  const text = raw.toString('latin1');

  // The boundary announced in the header must be the one delimiting the body.
  const boundary = /boundary=(.+)$/.exec(post.init!.headers!['Content-Type'])![1];
  assert.ok(text.startsWith(`--${boundary}\r\n`));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));

  // S3 rejects a presigned POST whose `file` part does not come last.
  const filePos = text.indexOf('name="file"');
  assert.ok(filePos !== -1);
  for (const name of ['key', 'policy', 'x-amz-signature']) {
    const pos = text.indexOf(`name="${name}"`);
    assert.ok(pos !== -1, `missing policy field ${name}`);
    assert.ok(pos < filePos, `policy field ${name} must precede the file part`);
  }

  // The attachment's bytes survive assembly unchanged.
  const marker = 'Content-Type: image/png\r\n\r\n';
  const start = text.indexOf(marker, filePos) + marker.length;
  assert.deepEqual(raw.subarray(start, start + PNG.length), PNG);

  const cont = JSON.parse(calls[2].init!.body as string);
  assert.deepEqual(cont.message, { type: 'text', text: '', attachedFileUrls: ['https://cdn/s3.png'] });
  assert.deepEqual(sent.map(s => s.text), ['Received']);
});
