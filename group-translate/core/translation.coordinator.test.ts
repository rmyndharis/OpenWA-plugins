import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationCoordinator, CoordinatorOptions } from './translation.coordinator';
import { ChatGateway, ConfigStore, GroupState, InboundMessage, Translator, TranslationLogger } from './ports';

const OPTS: CoordinatorOptions = { prefix: '/tr', minLength: 2, maxLength: 2000, denyReply: false };

function freshState(over: Partial<GroupState> = {}): GroupState {
  return {
    sessionId: 's',
    chatId: 'g@g.us',
    active: false,
    participants: {},
    delegatedControllers: [],
    announced: false,
    ...over,
  };
}

function makeDeps(state: GroupState) {
  const saved: GroupState[] = [];

  // store spies
  const loadCalls: unknown[][] = [];
  const saveCalls: unknown[][] = [];
  const load = async (_sessionId: string, _chatId: string): Promise<GroupState> => {
    loadCalls.push([_sessionId, _chatId]);
    return state;
  };
  const save = async (s: GroupState): Promise<void> => {
    saveCalls.push([s]);
    saved.push(JSON.parse(JSON.stringify(s)) as GroupState);
  };

  // gateway spies
  const sendTextCalls: unknown[][] = [];
  const sendCombinedReplyCalls: unknown[][] = [];
  const getGroupAdminsCalls: unknown[][] = [];
  let getGroupAdminsResult: string[] = [];
  const sendText = async (_sessionId: string, _chatId: string, _text: string): Promise<void> => {
    sendTextCalls.push([_sessionId, _chatId, _text]);
  };
  const sendCombinedReply = async (_sessionId: string, _chatId: string, _quotedId: string, _text: string): Promise<void> => {
    sendCombinedReplyCalls.push([_sessionId, _chatId, _quotedId, _text]);
  };
  const getGroupAdmins = async (_sessionId: string, _chatId: string): Promise<string[]> => {
    getGroupAdminsCalls.push([_sessionId, _chatId]);
    return getGroupAdminsResult;
  };

  // translator spies
  const detectCalls: unknown[][] = [];
  const translateCalls: unknown[][] = [];
  const languagesCalls: unknown[][] = [];
  const isHealthyCalls: unknown[][] = [];
  let detectImpl: (text: string) => Promise<{ lang: string; confidence: number }> = async () => ({ lang: 'en', confidence: 0.99 });
  let translateImpl: (text: string, source: string, target: string) => Promise<string> = async () => '';
  let languagesResult: string[] = ['en', 'es', 'fr'];
  let isHealthyResult = true;
  const detect = async (text: string) => {
    detectCalls.push([text]);
    return detectImpl(text);
  };
  const translate = async (text: string, source: string, target: string): Promise<string> => {
    translateCalls.push([text, source, target]);
    return translateImpl(text, source, target);
  };
  const languages = async (): Promise<string[]> => {
    languagesCalls.push([]);
    return languagesResult;
  };
  const isHealthy = (): boolean => {
    isHealthyCalls.push([]);
    return isHealthyResult;
  };

  // logger spies
  const debugCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  const debug = (message: string, meta?: Record<string, unknown>) => { debugCalls.push([message, meta]); };
  const info = (message: string, meta?: Record<string, unknown>) => { infoCalls.push([message, meta]); };
  const warn = (message: string, meta?: Record<string, unknown>) => { warnCalls.push([message, meta]); };

  const store: ConfigStore = { load, save };
  const gateway: ChatGateway = { sendText, sendCombinedReply, getGroupAdmins };
  const translator: Translator = { detect, translate, languages, isHealthy };
  const logger: TranslationLogger = { debug, info, warn };

  const mocks = {
    load: { calls: loadCalls },
    save: { calls: saveCalls },
    sendText: { calls: sendTextCalls },
    sendCombinedReply: { calls: sendCombinedReplyCalls },
    getGroupAdmins: {
      calls: getGroupAdminsCalls,
      mockResolvedValue: (v: string[]) => { getGroupAdminsResult = v; },
    },
    detect: {
      calls: detectCalls,
      mockResolvedValue: (v: { lang: string; confidence: number }) => { detectImpl = async () => v; },
    },
    translate: {
      calls: translateCalls,
      mockResolvedValue: (v: string) => { translateImpl = async () => v; },
      mockImplementation: (fn: (t: string, s: string, tgt: string) => Promise<string>) => { translateImpl = fn; },
    },
    languages: {
      calls: languagesCalls,
      mockResolvedValue: (v: string[]) => { languagesResult = v; },
    },
    isHealthy: {
      calls: isHealthyCalls,
      mockReturnValue: (v: boolean) => { isHealthyResult = v; },
    },
    debug: { calls: debugCalls },
    info: { calls: infoCalls },
    warn: { calls: warnCalls },
  };

  return {
    store,
    gateway,
    translator,
    logger,
    saved,
    mocks,
  };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'M1',
    chatId: 'g@g.us',
    body: 'hello',
    author: '111@c.us',
    isGroup: true,
    fromMe: false,
    mentionedIds: [],
    ...over,
  };
}

describe('TranslationCoordinator', () => {
  test('ignores non-group and fromMe messages', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    assert.deepEqual(await c.handleMessage('s', msg({ isGroup: false })), { swallow: false });
    assert.deepEqual(await c.handleMessage('s', msg({ fromMe: true })), { swallow: false });
    assert.equal(mocks.sendText.calls.length, 0);
  });

  test('announces once on first contact then stays dormant', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg());
    assert.equal(mocks.sendText.calls.length, 1);
    assert.ok(mocks.save.calls.length > 0);
  });

  test('activates only for an admin', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['111@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active, true);
  });

  test('recognizes a resolved-lid admin once group ids share the @c.us dialect', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['628111@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ author: '628111@c.us', body: '/tr on' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active, true);
  });

  test('regression guard: a raw @lid admin list does NOT match a resolved @c.us author', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['111@lid']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ author: '628111@c.us', body: '/tr on' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active ?? false, false);
  });

  test('rejects activation from a non-admin (silent by default)', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['999@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active ?? false, false);
  });

  test('translates an active-group message into other participants languages (skipping the source)', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ author: '111@c.us', body: 'Hello' }));
    assert.deepEqual(res, { swallow: false });
    assert.ok(mocks.translate.calls.some(call => JSON.stringify(call) === JSON.stringify(['Hello', 'en', 'es'])));
    assert.ok(mocks.sendCombinedReply.calls.length > 0);
    assert.ok((mocks.sendCombinedReply.calls.at(-1) as string[])[3].includes('Hola'));
  });

  test('falls back to the sender language and never translates into the source when detection misfires', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 3, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 3, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'gl', confidence: 0.5 });
    mocks.translate.mockResolvedValue('Let me know');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ author: '222@c.us', body: 'Haber dime que debo darte' }));
    assert.equal(mocks.translate.calls.length, 1);
    assert.deepEqual(mocks.translate.calls[0], ['Haber dime que debo darte', 'es', 'en']);
    assert.ok(!mocks.translate.calls.some(call => (call as string[])[2] === 'es'));
  });

  test('learns a sender language only after a 2-message debounce', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 5, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    mocks.translate.mockResolvedValue('x');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Bonjour' }));
    assert.equal(saved.at(-1)?.participants['111@c.us'].lang, 'en');
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Salut' }));
    assert.equal(saved.at(-1)?.participants['111@c.us'].lang, 'fr');
  });

  test('skips trivial messages below minLength', async () => {
    const state = freshState({ announced: true, active: true });
    const { store, gateway, translator, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ body: '.' }));
    assert.equal(mocks.detect.calls.length, 0);
    assert.equal(mocks.sendCombinedReply.calls.length, 0);
  });

  test('records the sender pushName on a translated message', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, logger, saved, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Hello', pushName: 'Doug' }));
    assert.equal(saved.at(-1)?.participants['111@c.us'].pushName, 'Doug');
  });

  test('reconciles a misrouted @lid author via a uniquely-matching pushName', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'liz@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Lizeth' },
        'doug@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Doug' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'es', confidence: 0.99 });
    mocks.translate.mockResolvedValue('I feel sick');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'doug@lid', pushName: 'Lizeth', body: 'Me siento mal' }));
    assert.ok(mocks.translate.calls.some(call => JSON.stringify(call) === JSON.stringify(['Me siento mal', 'es', 'en'])));
    assert.ok(mocks.sendCombinedReply.calls.length > 0);
    assert.ok(
      mocks.info.calls.some(call => {
        const [message, meta] = call as [string, Record<string, unknown>];
        return message === 'sender reconciled by pushName' && meta?.resolvedKey === 'liz@lid';
      }),
    );
  });

  test('does not reconcile when the author already owns the pushName', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'a@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
        'b@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'es', confidence: 0.99 });
    mocks.translate.mockResolvedValue('hi');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'a@lid', pushName: 'Sam', body: 'Hola amigo' }));
    assert.ok(
      !mocks.info.calls.some(call => (call as [string, unknown])[0] === 'sender reconciled by pushName'),
    );
    assert.ok(mocks.translate.calls.some(call => JSON.stringify(call) === JSON.stringify(['Hola amigo', 'es', 'en'])));
  });

  test('does not reconcile when the pushName is ambiguous across participants', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'x@lid': { lang: 'fr', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Xavier' },
        'a@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
        'b@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x', pushName: 'Sam' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'fr', confidence: 0.99 });
    mocks.translate.mockResolvedValue('x');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'x@lid', pushName: 'Sam', body: 'Bonjour tout le monde' }));
    assert.ok(
      !mocks.info.calls.some(call => (call as [string, unknown])[0] === 'sender reconciled by pushName'),
    );
    assert.ok(
      mocks.debug.calls.some(call => {
        const [message, meta] = call as [string, Record<string, unknown>];
        return message === 'ambiguous pushName; not reconciling' && meta?.author === 'x@lid';
      }),
    );
  });

  test('engages the backstop instead of dropping when source != senderLang', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'liz@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Lizeth' },
        'doug@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'Doug' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'es', confidence: 0.99 });
    mocks.translate.mockResolvedValue('I feel sick');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'doug@lid', pushName: 'Doug', body: 'Me siento mal' }));
    assert.ok(
      mocks.warn.calls.some(call => {
        const [message, meta] = call as [string, Record<string, unknown>];
        return message === 'target backstop engaged (possible misroute or cross-language write)' && meta?.source === 'es';
      }),
    );
    assert.ok(mocks.translate.calls.some(call => JSON.stringify(call) === JSON.stringify(['Me siento mal', 'es', 'en'])));
    assert.ok(mocks.sendCombinedReply.calls.length > 0);
  });

  test('does not warn or translate when the group speaks only the source language', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        'a@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'A' },
        'b@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'B' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 'a@lid', pushName: 'A', body: 'Hello there' }));
    assert.equal(mocks.translate.calls.length, 0);
    assert.equal(mocks.warn.calls.length, 0);
    assert.equal(mocks.sendCombinedReply.calls.length, 0);
  });

  test('warns on a failed translate call and still delivers the successful targets', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        's1@lid': { lang: 'en', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'S1' },
        's2@lid': { lang: 'es', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'S2' },
        's3@lid': { lang: 'fr', source: 'pinned', enabled: true, samples: 5, updatedAt: 'x', pushName: 'S3' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockImplementation((_t: string, _s: string, target: string) =>
      target === 'fr' ? Promise.reject(new Error('boom')) : Promise.resolve('Hola'),
    );
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: 's1@lid', pushName: 'S1', body: 'Hello everyone' }));
    assert.ok(
      mocks.warn.calls.some(call => {
        const [message, meta] = call as [string, Record<string, unknown>];
        return message === 'translate call failed' && meta?.target === 'fr';
      }),
    );
    assert.ok(mocks.sendCombinedReply.calls.length > 0);
    assert.ok((mocks.sendCombinedReply.calls.at(-1) as string[])[3].includes('Hola'));
  });

  test('emits a decision debug log for each translated message', async () => {
    const state = freshState({
      announced: true,
      active: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x', pushName: 'D' },
        '222@c.us': { lang: 'es', source: 'pinned', enabled: true, samples: 2, updatedAt: 'x', pushName: 'L' },
      },
    });
    const { store, gateway, translator, logger, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('Hola');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS, logger);
    await c.handleMessage('s', msg({ author: '111@c.us', pushName: 'D', body: 'Hello' }));
    assert.ok(
      mocks.debug.calls.some(call => {
        const [message, meta] = call as [string, Record<string, unknown>];
        return message === 'translate decision' && meta?.detected === 'en' && meta?.source === 'en' && meta?.sent === 1;
      }),
    );
  });

  test('a sender wid of __proto__ does not pollute Object.prototype', async () => {
    const { store, gateway, translator } = makeDeps(freshState({ active: true, announced: true }));
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ author: '__proto__', pushName: 'EVIL', body: 'hola amigo mio' }));
    const leaked = (Object.prototype as Record<string, unknown>).pushName;
    delete (Object.prototype as Record<string, unknown>).pushName; // cleanup regardless of assertion outcome
    assert.equal(leaked, undefined, 'Object.prototype must not be polluted via a crafted participant wid');
  });

  test('concurrent first messages for the same group announce only once', async () => {
    let current: GroupState = freshState({ active: false, announced: false });
    const sends: string[] = [];
    const store: ConfigStore = {
      load: async () => { await Promise.resolve(); return JSON.parse(JSON.stringify(current)) as GroupState; },
      save: async (s: GroupState) => { await Promise.resolve(); current = JSON.parse(JSON.stringify(s)) as GroupState; },
    };
    const gateway: ChatGateway = {
      sendText: async (_s: string, _c: string, text: string) => { await Promise.resolve(); sends.push(text); },
      sendCombinedReply: async () => {},
      getGroupAdmins: async () => [],
    };
    const translator: Translator = {
      detect: async () => ({ lang: 'en', confidence: 1 }), translate: async () => '',
      languages: async () => ['en'], isHealthy: () => true,
    };
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await Promise.all([
      c.handleMessage('s', msg({ id: 'm1', body: 'hello there' })),
      c.handleMessage('s', msg({ id: 'm2', body: 'hello again' })),
    ]);
    assert.equal(sends.length, 1, 'the help announcement must be sent once, not duplicated by a load/save race');
  });
});
