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
