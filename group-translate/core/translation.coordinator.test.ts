import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationCoordinator, CoordinatorOptions, isUrlOrEmojiOnly } from './translation.coordinator';
import { ChatGateway, ConfigStore, GroupState, InboundMessage, Translator, TranslationLogger } from './ports';

// The shipped defaults, so every test below runs against what an operator actually gets.
const OPTS: CoordinatorOptions = {
  prefix: '/tr',
  minLength: 2,
  maxLength: 2000,
  denyReply: false,
  announceInGroups: false,
};

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
  const resolveCanonicalWidCalls: unknown[][] = [];
  // Default: the host resolves nothing, which is the pre-existing behaviour every older test asserts.
  let resolveCanonicalWidResult: string | null = null;
  const resolveCanonicalWid = async (_sessionId: string, _wid: string): Promise<string | null> => {
    resolveCanonicalWidCalls.push([_sessionId, _wid]);
    return resolveCanonicalWidResult;
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
  const gateway: ChatGateway = { sendText, sendCombinedReply, getGroupAdmins, resolveCanonicalWid };
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
    resolveCanonicalWid: {
      calls: resolveCanonicalWidCalls,
      mockResolvedValue: (v: string | null) => { resolveCanonicalWidResult = v; },
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

  // Regression: enabling this plugin used to post an unsolicited introduction into a group the first
  // time it saw any message there. Per group, so a single enable announced the bot into every group
  // the account belonged to — on a personal WhatsApp that is every group the person is in. The
  // introduction is now opt-in, and this asserts the DEFAULT, which is the value that shipped harm.
  test('says nothing in a group it has never seen before (announcement off by default)', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg());
    assert.deepEqual(res, { swallow: false }, 'an ordinary group message is not claimed');
    assert.equal(mocks.sendText.calls.length, 0, 'the plugin must not speak until it is addressed');
  });

  test('announces once per group when the operator opts in', async () => {
    const state = freshState();
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    const c = new TranslationCoordinator(translator, store, gateway, { ...OPTS, announceInGroups: true });
    await c.handleMessage('s', msg());
    assert.equal(mocks.sendText.calls.length, 1);
    assert.equal(saved.at(-1)?.announced, true, 'the group is marked so the intro is not repeated');
  });

  // The intro is still reachable on demand — which is why suppressing it costs nothing.
  test('replies with the help text when asked, whatever the announcement setting', async () => {
    const { store, gateway, translator, mocks } = makeDeps(freshState());
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr help' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(mocks.sendText.calls.length, 1);
    assert.match(String(mocks.sendText.calls[0][2]), /Translation bot/);
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

  // Regression, reproduced live on an OpenWA 0.12.1 host: WhatsApp delivered the author as
  // `148004841455867@lid` while getGroupInfo listed that same person as `6281770008896@c.us`. The two
  // user numbers are unrelated, so a promoted admin was refused `/tr on` and the group had no working
  // administrator at all — its owner was the bot's own number, whose messages never reach this code.
  test('activates for an admin whose author id arrives in the @lid dialect', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['6281770008896@c.us']); // participant list, @c.us
    mocks.resolveCanonicalWid.mockResolvedValue('6281770008896@c.us'); // what the host resolves it to
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);

    const res = await c.handleMessage('s', msg({ author: '148004841455867@lid', body: '/tr on' }));

    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active, true, 'the admin must be recognized across the lid/phone split');
  });

  test('a delegated controller named by phone number is recognized behind a @lid author', async () => {
    const state = freshState({ announced: true, delegatedControllers: ['6281770008896@c.us'] });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['999@c.us']); // not an admin — delegation is the only route
    mocks.resolveCanonicalWid.mockResolvedValue('6281770008896@c.us');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);

    await c.handleMessage('s', msg({ author: '148004841455867@lid', body: '/tr on' }));

    assert.equal(saved.at(-1)?.active, true, '/tr grant stores @c.us, so it needs the same bridge');
  });

  test('still refuses a genuine non-admin after resolving their canonical id', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['6289999999999@c.us']);
    mocks.resolveCanonicalWid.mockResolvedValue('6281770008896@c.us'); // resolvable, but not an admin
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);

    await c.handleMessage('s', msg({ author: '148004841455867@lid', body: '/tr on' }));

    assert.equal(saved.at(-1)?.active ?? false, false, 'resolution must not become a bypass');
  });

  test('does not spend a resolution round-trip when the direct comparison already authorizes', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['111@c.us']); // matches the default author directly
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);

    await c.handleMessage('s', msg({ body: '/tr on' }));

    assert.equal(mocks.resolveCanonicalWid.calls.length, 0, 'the extra engine call is for denials only');
  });

  test('memoizes the canonical id across commands from the same author', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['6281770008896@c.us']);
    mocks.resolveCanonicalWid.mockResolvedValue('6281770008896@c.us');
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);

    await c.handleMessage('s', msg({ author: '148004841455867@lid', body: '/tr on' }));
    await c.handleMessage('s', msg({ author: '148004841455867@lid', body: '/tr off' }));

    assert.equal(mocks.resolveCanonicalWid.calls.length, 1, 'a lid<->phone binding does not change');
  });

  test('falls back to the direct comparison when the host cannot resolve the author', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['6281770008896@c.us']);
    mocks.resolveCanonicalWid.mockResolvedValue(null); // unknown contact, slow engine, dead session
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);

    await c.handleMessage('s', msg({ author: '148004841455867@lid', body: '/tr on' }));

    assert.equal(saved.at(-1)?.active ?? false, false, 'unresolvable must deny, never fail open');
  });

  test('rejects activation from a non-admin silently by default (denyReply false)', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['999@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active ?? false, false);
    assert.equal(mocks.sendText.calls.length, 0, 'denyReply defaults false: a denied command must not reply');
  });

  test('replies "admins only" on a denied command when denyReply is enabled', async () => {
    const state = freshState({ announced: true });
    const { store, gateway, translator, saved, mocks } = makeDeps(state);
    mocks.getGroupAdmins.mockResolvedValue(['999@c.us']);
    const c = new TranslationCoordinator(translator, store, gateway, { ...OPTS, denyReply: true });
    const res = await c.handleMessage('s', msg({ body: '/tr on' }));
    assert.deepEqual(res, { swallow: true });
    assert.equal(saved.at(-1)?.active ?? false, false);
    assert.equal(mocks.sendText.calls.length, 1);
    assert.match(String((mocks.sendText.calls[0] as unknown[])[2]), /admins/i);
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

  // A backend that answers 200 with a blank translation is real. The formatter prefixes every entry with
  // a flag and language code, so a blank one still renders a non-empty "🇪🇸 ES:" bubble — the emptiness
  // guard has to live where the translation is COLLECTED, not at the send.
  test('a blank translation is dropped, not shipped as a flag-only bubble', async () => {
    const state = freshState({
      active: true,
      announced: true,
      participants: {
        '111@c.us': { lang: 'en', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
        '222@c.us': { lang: 'es', source: 'learned', enabled: true, samples: 2, updatedAt: 'x' },
      },
    });
    const { store, gateway, translator, mocks } = makeDeps(state);
    mocks.detect.mockResolvedValue({ lang: 'en', confidence: 0.99 });
    mocks.translate.mockResolvedValue('   ');   // 200 OK, but blank
    const c = new TranslationCoordinator(translator, store, gateway, OPTS);
    await c.handleMessage('s', msg({ author: '111@c.us', body: 'Hello' }));
    assert.ok(mocks.translate.calls.length > 0, 'guard: the translate path really ran');
    assert.equal(mocks.sendCombinedReply.calls.length, 0, 'a blank translation must not be sent');
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
      resolveCanonicalWid: async () => null,
    };
    const translator: Translator = {
      detect: async () => ({ lang: 'en', confidence: 1 }), translate: async () => '',
      languages: async () => ['en'], isHealthy: () => true,
    };
    // Opted in deliberately: the announcement is this test's observable for the per-chat lock, and
    // it is the one send that a load/save race could duplicate.
    const c = new TranslationCoordinator(translator, store, gateway, { ...OPTS, announceInGroups: true });
    await Promise.all([
      c.handleMessage('s', msg({ id: 'm1', body: 'hello there' })),
      c.handleMessage('s', msg({ id: 'm2', body: 'hello again' })),
    ]);
    assert.equal(sends.length, 1, 'the help announcement must be sent once, not duplicated by a load/save race');
  });
});

test('the skip filter stays linear on adversarial input', () => {
  // The filter was /^(?:\s|\p{Emoji}|https?:\/\/\S+)+$/u. `\p{Emoji}` matches ASCII digits, `#` and `*`
  // — they are keycap-sequence components — so it overlapped `\S+` in the URL branch and every extra
  // token multiplied the backtracking space. Measured on the real pattern: nine tokens over 145
  // characters took 5.5 s, while the same payload with letters took 0.0 ms. maxLength defaults to 2000,
  // and any member of a group with /tr on could send it. JS regex execution cannot be interrupted, so
  // this held the worker's event loop outright.
  const payload = `${Array(9).fill('http://11111111').join(' ')} a`;
  const started = performance.now();
  const skip = isUrlOrEmojiOnly(payload);
  const elapsed = performance.now() - started;

  assert.equal(skip, false, 'the trailing word makes this translatable, not skippable');
  assert.ok(elapsed < 100, `filter took ${elapsed.toFixed(1)} ms on ${payload.length} characters`);
});

test('the skip filter still recognises what it is meant to skip', () => {
  for (const skippable of ['https://example.com', 'http://a.co https://b.co', '👍', '👍 🎉', '   ', 'https://a.co 👍']) {
    assert.equal(isUrlOrEmojiOnly(skippable), true, `should skip: ${JSON.stringify(skippable)}`);
  }
  for (const translatable of ['hello', 'https://a.co and text', 'lihat https://a.co ya', '1', 'halo 👍']) {
    assert.equal(isUrlOrEmojiOnly(translatable), false, `should translate: ${JSON.stringify(translatable)}`);
  }
});
