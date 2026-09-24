import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginChatGateway } from './plugin-chat.gateway';

function makeMessages() {
  const calls: Record<string, unknown[][]> = { sendText: [], reply: [] };
  return {
    sendText: async (...args: unknown[]) => { calls.sendText.push(args); return {}; },
    reply: async (...args: unknown[]) => { calls.reply.push(args); return {}; },
    calls,
  };
}

test('sendText routes through ctx.messages.sendText', async () => {
  const messages = makeMessages();
  const engine = { getGroupInfo: async () => null };
  const gw = new PluginChatGateway(messages as never, engine as never);
  await gw.sendText('s', 'c@g.us', 'hi');
  assert.deepEqual(messages.calls.sendText[0], ['s', 'c@g.us', 'hi']);
});

test('sendCombinedReply routes through ctx.messages.reply', async () => {
  const messages = makeMessages();
  const engine = { getGroupInfo: async () => null };
  const gw = new PluginChatGateway(messages as never, engine as never);
  await gw.sendCombinedReply('s', 'c@g.us', 'M1', 'Hola');
  assert.deepEqual(messages.calls.reply[0], ['s', 'c@g.us', 'M1', 'Hola']);
});

test('getGroupAdmins includes phone-scheme admins + the LID owner, deduped', async () => {
  const messages = makeMessages();
  const engine = {
    getGroupInfo: async () => ({
      owner: '149207180681386@lid',
      participants: [
        { id: '19729002902@c.us', isAdmin: true, isSuperAdmin: true },
        { id: '573133889572@c.us', isAdmin: false, isSuperAdmin: false },
      ],
    }),
  };
  const gw = new PluginChatGateway(messages as never, engine as never);
  const admins = await gw.getGroupAdmins('s', 'c@g.us');
  assert.ok(admins.includes('19729002902@c.us'), 'should include the admin participant');
  assert.ok(admins.includes('149207180681386@lid'), 'should include the LID owner');
  assert.ok(!admins.includes('573133889572@c.us'), 'should NOT include non-admin participant');
});

test('getGroupAdmins returns [] when there is no group info', async () => {
  const messages = makeMessages();
  const engine = { getGroupInfo: async () => null };
  const gw = new PluginChatGateway(messages as never, engine as never);
  assert.deepEqual(await gw.getGroupAdmins('s', 'c@g.us'), []);
});

// The host rejects an empty positional capability argument outright, so an empty translation stopped
// being a blank WhatsApp bubble and became a thrown capability error instead.
test('an empty or whitespace-only translation is dropped, not sent', async () => {
  const messages = makeMessages();
  const engine = { getGroupInfo: async () => null };
  const gw = new PluginChatGateway(messages as never, engine as never);
  await gw.sendText('s', 'c@g.us', '');
  await gw.sendText('s', 'c@g.us', '   ');
  await gw.sendCombinedReply('s', 'c@g.us', 'q', '');
  assert.equal(messages.calls.sendText.length, 0);
  assert.equal(messages.calls.reply.length, 0);
});

test('resolveCanonicalWid resolves null for an unknown contact and rejects when the host gave no answer', async () => {
  const messages = makeMessages();
  const unknown = new PluginChatGateway(messages as never, { getContactById: async () => null } as never);
  assert.equal(await unknown.resolveCanonicalWid('s', '1@lid'), null);

  const engine = {
    getContactById: async () => { throw new Error('capability engine.getContactById timed out after 30000ms'); },
  };
  const silent = new PluginChatGateway(messages as never, engine as never);
  await assert.rejects(silent.resolveCanonicalWid('s', '1@lid'), /timed out/);
});
