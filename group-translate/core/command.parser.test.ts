import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './command.parser';

describe('parseCommand', () => {
  test('returns null for non-prefixed text', () => {
    assert.equal(parseCommand('hello world', '/tr'), null);
  });

  test('parses bare commands', () => {
    assert.deepEqual(parseCommand('/tr on', '/tr'), { name: 'on' });
    assert.deepEqual(parseCommand('/tr help', '/tr'), { name: 'help' });
  });

  test('accepts the /translate alias and is case-insensitive on the verb', () => {
    assert.deepEqual(parseCommand('/translate OFF', '/tr'), { name: 'off' });
  });

  test('parses setlang with default me target', () => {
    assert.deepEqual(parseCommand('/tr setlang es', '/tr'), {
      name: 'setlang',
      lang: 'es',
      target: { kind: 'me' },
    });
  });

  test('parses a number target', () => {
    assert.deepEqual(parseCommand('/tr grant 14155551212', '/tr'), {
      name: 'grant',
      target: { kind: 'number', number: '14155551212' },
    });
  });

  test('parses a mention target', () => {
    assert.deepEqual(parseCommand('/tr ignore @someone', '/tr'), {
      name: 'ignore',
      target: { kind: 'mention' },
    });
  });

  test('returns null for an unknown verb', () => {
    assert.equal(parseCommand('/tr frobnicate', '/tr'), null);
  });
});
