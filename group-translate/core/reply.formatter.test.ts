import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatCombinedReply, buildHelpText, formatStatus } from './reply.formatter';
import { GroupState } from './ports';

describe('reply.formatter', () => {
  test('formats one line per translation with an uppercased code label', () => {
    const out = formatCombinedReply([
      { lang: 'es', text: 'Hola' },
      { lang: 'fr', text: 'Bonjour' },
    ]);
    assert.ok(out.includes('Hola'));
    assert.ok(out.includes('Bonjour'));
    assert.equal(out.split('\n').length, 2);
    assert.ok(/ES/.test(out));
  });

  test('buildHelpText lists key commands with the active prefix', () => {
    const help = buildHelpText('/tr');
    assert.ok(help.includes('/tr on'));
    assert.ok(help.includes('/tr setlang'));
  });

  test('formatStatus reports active state and participants', () => {
    const state: GroupState = {
      sessionId: 's',
      chatId: 'c@g.us',
      active: true,
      participants: { '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' } },
      delegatedControllers: [],
      announced: true,
    };
    const out = formatStatus(state, true);
    assert.ok(/active/i.test(out));
    assert.ok(out.includes('en'));
  });
});
