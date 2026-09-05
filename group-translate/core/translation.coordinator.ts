import {
  ChatGateway,
  ConfigStore,
  GroupState,
  InboundMessage,
  ParsedCommand,
  ParticipantState,
  Translation,
  Translator,
  TranslationLogger,
  CommandTarget,
} from './ports';
import { parseCommand } from './command.parser';
import { buildHelpText, formatCombinedReply, formatStatus } from './reply.formatter';

export interface CoordinatorOptions {
  prefix: string;
  minLength: number;
  maxLength: number;
  denyReply: boolean;
  /** Post the unsolicited introduction into a group the first time this plugin sees a message there.
   *  Off unless the operator turns it on: the account running this plugin is usually a person's own
   *  WhatsApp, and enabling the plugin would otherwise announce it into every group that account is in. */
  announceInGroups: boolean;
}

// One token that is nothing but picture characters — pictographic base, skin-tone modifier, variation
// selector, or the zero-width joiner that binds a composite emoji together.
const EMOJI_RUN = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]+$/u;

/**
 * True when a message carries nothing worth translating: whitespace, links, emoji, or a mix.
 *
 * Scanned token by token rather than matched as one pattern. The previous form,
 * `/^(?:\s|\p{Emoji}|https?:\/\/\S+)+$/u`, backtracked catastrophically — `\p{Emoji}` matches ASCII
 * digits, `#` and `*` (they are keycap-sequence components), so it overlapped `\S+` in the URL branch
 * and every additional token multiplied the search space. 145 characters took seconds, and `maxLength`
 * allows 2000. `\p{Extended_Pictographic}` is the property that actually means "picture character",
 * which also stops a message of "1" from being classed as emoji and silently left untranslated.
 */
export function isUrlOrEmojiOnly(text: string): boolean {
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return true;
  return tokens.every(
    (token) => token.startsWith('http://') || token.startsWith('https://') || EMOJI_RUN.test(token),
  );
}

/** Object keys that index the prototype chain rather than an own property; never valid as a wid. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const NOOP_LOGGER: TranslationLogger = { debug: () => {}, info: () => {}, warn: () => {} };

/** Cap on the memoized author -> canonical-wid table. One entry per distinct author whose command
 *  needed resolving, so this only fills up in a deployment with many groups and many commanders. */
const MAX_CANONICAL_WIDS = 500;

/** Minimum gap between two `/tr help` answers in the same group. */
const HELP_COOLDOWN_MS = 60_000;

/** Cap on the per-group `/tr help` timestamps, mirroring MAX_CANONICAL_WIDS: one entry per group that
 *  has asked, evicted oldest-first rather than growing without limit. */
const MAX_HELP_ENTRIES = 500;

/**
 * Compare two WhatsApp IDs tolerantly: exact match, or same user part ignoring
 * an `@domain` and any `:device` suffix (e.g. `123@c.us` === `123:7@c.us`).
 * Note: this does NOT bridge the LID (`@lid`) and phone (`@c.us`) namespaces —
 * those have different user numbers (see spec §16).
 */
function widEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const userPart = (w: string): string => w.split('@')[0].split(':')[0];
  return userPart(a) === userPart(b);
}

export class TranslationCoordinator {
  /** Per (session,chat) promise chain serializing the load→mutate→save cycle. Self-evicts when drained. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** `${sessionId}:${wid}` -> canonical `@c.us` wid, or null when the host could not resolve it. */
  private readonly canonicalWids = new Map<string, string | null>();
  /** `${sessionId}:${chatId}` -> epoch ms of the last `/tr help` answer posted there. In memory and per
   *  coordinator, like the LibreTranslate circuit breaker: a rebuild or a disable/enable clears it,
   *  which at worst allows one extra answer. */
  private readonly helpAt = new Map<string, number>();

  constructor(
    private readonly translator: Translator,
    private readonly store: ConfigStore,
    private readonly gateway: ChatGateway,
    private readonly opts: CoordinatorOptions,
    private readonly logger: TranslationLogger = NOOP_LOGGER,
  ) {}

  async handleMessage(sessionId: string, msg: InboundMessage): Promise<{ swallow: boolean }> {
    if (!msg.isGroup || msg.fromMe || !msg.author) return { swallow: false };
    // Concurrent messages for the same group must not interleave load→mutate→save (lost updates /
    // duplicate announcements). Chain each behind the previous for the same key; store a settled tail
    // so one rejection can't wedge the chain, and evict the entry once the chain drains.
    const key = `${sessionId}:${msg.chatId}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.handleMessageLocked(sessionId, msg));
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async handleMessageLocked(sessionId: string, msg: InboundMessage): Promise<{ swallow: boolean }> {
    const state = await this.store.load(sessionId, msg.chatId);

    // Opt-in, and off by default. This is the only place the plugin speaks without being addressed,
    // and it fires per GROUP, so simply enabling the plugin used to post an introduction into every
    // group the account was in. `/tr help` gives anyone the same text on request.
    if (this.opts.announceInGroups && !state.announced) {
      await this.gateway.sendText(sessionId, msg.chatId, buildHelpText(this.opts.prefix));
      state.announced = true;
      await this.store.save(state);
    }

    const command = parseCommand(msg.body, this.opts.prefix);
    if (command) {
      await this.handleCommand(sessionId, msg, state, command);
      return { swallow: true };
    }

    if (!state.active) return { swallow: false };
    await this.translateMessage(sessionId, msg, state);
    return { swallow: false };
  }

  private async translateMessage(sessionId: string, msg: InboundMessage, state: GroupState): Promise<void> {
    const text = msg.body.trim();
    if (text.length < this.opts.minLength || text.length > this.opts.maxLength || isUrlOrEmojiOnly(text)) {
      return;
    }

    const senderKey = this.resolveSenderKey(state, msg);
    const sender = this.ensureParticipant(state, senderKey);
    // Record the pushName, but never overwrite a different existing value (a misrouted message
    // could otherwise poison the identity anchor).
    if (msg.pushName && (sender.pushName === undefined || sender.pushName === msg.pushName)) {
      sender.pushName = msg.pushName;
    }
    if (!sender.enabled) return;

    let detected: string;
    try {
      detected = (await this.translator.detect(text)).lang;
    } catch (err) {
      // Every backend failure lands here: an unreachable instance, a host that refused the fetch
      // because libretranslateUrl names something the allowlist does not admit, the SSRF guard blocking
      // a loopback address without SSRF_ALLOWED_HOSTS. This used to return with nothing recorded at
      // all, so a group that had simply stopped being translated left no trace of why.
      this.logger.warn('detect failed; message left untranslated', {
        action: 'translation_detect_failed',
        error: String(err),
      });
      return;
    }
    this.applyLearning(sender, detected);

    // Pick the effective source language. Detection misfires on short/colloquial text — it often
    // returns a near-neighbour language (e.g. es misread as gl/ca) — so trust the detected code only
    // when it names a language the group actually uses; otherwise fall back to the sender's known
    // language. Combined with excluding the sender's own language from the targets below, this stops
    // a message ever being "translated" into its own language (the duplicate/echo bug).
    const knownLangs = this.knownLanguages(state);
    const source = knownLangs.includes(detected) ? detected : (sender.lang ?? detected);

    let targets = this.targetLanguages(state, source, sender.lang);
    if (targets.length === 0) {
      // Backstop: a real message detected in a known language must never be silently dropped due
      // to a sender/source mismatch (e.g. a misrouted @lid author keyed to the wrong participant).
      // Translate into every known language except the source — guarantees delivery.
      const backstop = knownLangs.filter(l => l !== source);
      if (backstop.length === 0) {
        this.logger.debug('no targets; group speaks only the source language', {
          action: 'translation_no_targets',
          source,
        });
        await this.store.save(state);
        return;
      }
      this.logger.warn('target backstop engaged (possible misroute or cross-language write)', {
        action: 'translation_backstop',
        author: msg.author,
        pushName: msg.pushName,
        source,
        senderLang: sender.lang,
        targets: backstop,
      });
      targets = backstop;
    }

    const settled = await Promise.allSettled(targets.map(t => this.translator.translate(text, source, t)));
    const translations: Translation[] = [];
    settled.forEach((r, i) => {
      // A blank translation is dropped HERE, not at the send: the formatter prefixes each entry with a
      // flag + language code, so an empty value still renders a non-empty "🇪🇸 ES:" bubble that the
      // gateway's emptiness guard can never see. Dropping it here also keeps the decision log honest.
      if (r.status === 'fulfilled') {
        if (r.value.trim()) translations.push({ lang: targets[i], text: r.value });
      } else {
        this.logger.warn('translate call failed', {
          action: 'translation_translate_failed',
          source,
          target: targets[i],
          error: String(r.reason),
        });
      }
    });

    this.logger.debug('translate decision', {
      action: 'translation_decision',
      author: msg.author,
      resolvedKey: senderKey,
      pushName: msg.pushName,
      detected,
      source,
      senderLang: sender.lang,
      knownLangs,
      targets,
      sent: translations.length,
    });

    if (translations.length > 0) {
      await this.gateway.sendCombinedReply(sessionId, msg.chatId, msg.id, formatCombinedReply(translations));
    }
    await this.store.save(state);
  }

  /** Distinct languages currently spoken by enabled participants. */
  private knownLanguages(state: GroupState): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang) langs.add(p.lang);
    }
    return [...langs];
  }

  /**
   * Distinct languages of enabled participants, excluding the message source language AND the
   * sender's own language — a sender never needs their own message translated back to themselves
   * (this also guards against a detection misfire leaving the source language in the target set).
   */
  private targetLanguages(state: GroupState, source: string, senderLang: string | null): string[] {
    const langs = new Set<string>();
    for (const p of Object.values(state.participants)) {
      if (p.enabled && p.lang && p.lang !== source && p.lang !== senderLang) langs.add(p.lang);
    }
    return [...langs];
  }

  /** 2-message debounce: a learned language only switches after a new language is seen twice in a row. */
  private applyLearning(p: ParticipantState, detected: string): void {
    p.samples++;
    if (p.source === 'pinned') return;
    if (p.lang === detected) {
      p.pendingLang = undefined;
      return;
    }
    if (p.pendingLang === detected) {
      p.lang = detected;
      p.pendingLang = undefined;
    } else {
      p.pendingLang = detected;
      if (p.lang === null) p.lang = detected; // cold start: adopt immediately
    }
    p.updatedAt = new Date().toISOString();
  }

  /**
   * Resolve which participant a message belongs to. whatsapp-web.js can misroute a group message's
   * `@lid` author after a reconnect; when the message's pushName uniquely identifies a DIFFERENT
   * known participant (and the author doesn't already own that pushName), trust the pushName.
   * Ambiguous (shared pushName) or no-match cases fall back to the raw author.
   */
  private resolveSenderKey(state: GroupState, msg: InboundMessage): string {
    const { author, pushName } = msg;
    if (!pushName) return author;
    // No conflict if the author already owns this pushName.
    if (state.participants[author]?.pushName === pushName) return author;
    const matches = Object.keys(state.participants).filter(
      key => key !== author && state.participants[key].pushName === pushName,
    );
    if (matches.length === 1) {
      this.logger.info('sender reconciled by pushName', {
        action: 'translation_sender_reconciled',
        author,
        resolvedKey: matches[0],
        pushName,
      });
      return matches[0];
    }
    if (matches.length > 1) {
      this.logger.debug('ambiguous pushName; not reconciling', {
        action: 'translation_pushname_ambiguous',
        author,
        pushName,
        matches,
      });
    }
    return author;
  }

  private ensureParticipant(state: GroupState, wid: string): ParticipantState {
    if (UNSAFE_KEYS.has(wid)) {
      // A real WhatsApp id never equals a prototype key; refuse to index the map by it so a crafted
      // author/target can't read or write Object.prototype. Return a throwaway, non-persisted state.
      return { lang: null, source: 'learned', enabled: true, samples: 0, updatedAt: '' };
    }
    if (!Object.prototype.hasOwnProperty.call(state.participants, wid)) {
      state.participants[wid] = { lang: null, source: 'learned', enabled: true, samples: 0, updatedAt: '' };
    }
    return state.participants[wid];
  }

  private async handleCommand(
    sessionId: string,
    msg: InboundMessage,
    state: GroupState,
    cmd: ParsedCommand,
  ): Promise<void> {
    if (cmd.name === 'help') {
      // The only reply this plugin gives a user it has not authorized, so it is also the only command a
      // stranger can repeat to make the bot post into the group on every attempt: exactly the
      // amplification the denial reply below is opt-in (denyReply) in order to withhold. Answer once
      // per group per window. The command stays discoverable, which is all it is for, and repeating it
      // adds nothing the first answer did not already say.
      if (this.helpDue(`${sessionId}:${msg.chatId}`)) {
        await this.gateway.sendText(sessionId, msg.chatId, buildHelpText(this.opts.prefix));
      }
      return;
    }

    // Every state-changing command is authorized, with no self-serve exemption. `setlang`/`auto`
    // targeting yourself used to skip this block entirely, which contradicted all three shipped
    // descriptions of the plugin (README "every other command is admin-only" and its per-command
    // table, and the manifest's "Admin-gated" that plugins.json publishes) and, because
    // parseCommand defaults an absent target to `me`, made the plain `<prefix> setlang es` form open
    // to anyone. The confirmation it sent is unconditional, so any member could draw a bot post into
    // the group on every attempt: the same amplification `help` is explicitly bounded against a few
    // lines up, but unbounded. Routing these through authorize is the fix rather than a second
    // cooldown, because with the default denyReply:false an unauthorized attempt now says nothing at
    // all, and it also puts the unvalidated-language write below behind an admin.
    const admins = await this.gateway.getGroupAdmins(sessionId, msg.chatId);
    const { isAdmin, isController } = await this.authorize(sessionId, msg, state, admins);
    const adminOnly = cmd.name === 'grant' || cmd.name === 'revoke';
    if ((adminOnly && !isAdmin) || (!adminOnly && !isController)) {
      // Reply on denial only when the operator opted in (denyReply). Default is silent, so an
      // unauthorized user spamming a restricted command can't amplify replies out of the group.
      if (this.opts.denyReply) {
        await this.gateway.sendText(
          sessionId,
          msg.chatId,
          adminOnly
            ? '⛔ Only group admins can use that command.'
            : '⛔ Only group admins or delegated users can use that command.',
        );
      }
      return;
    }

    const targetWid = this.resolveTarget(msg, cmd.target);

    switch (cmd.name) {
      case 'status':
        // Behind the same gate as every other command. The participant table is this plugin's own
        // access-control state (who is ignored, who holds delegated control, the language learned for
        // each member), and answering any member on every attempt both published that roster and gave
        // back the amplification `/tr help` is bounded against above.
        await this.gateway.sendText(sessionId, msg.chatId, formatStatus(state, this.translator.isHealthy()));
        return;
      case 'on':
        state.active = true;
        await this.confirm(sessionId, msg, '✅ Translation activated.', state);
        return;
      case 'off':
        state.active = false;
        await this.confirm(sessionId, msg, '✅ Translation deactivated.', state);
        return;
      case 'setlang': {
        if (!targetWid || !cmd.lang)
          return this.replyError(sessionId, msg, 'Usage: ' + this.opts.prefix + ' setlang <code> [me|@user|number]');
        const langs = await this.safeLanguages();
        if (langs && !langs.includes(cmd.lang)) {
          return this.replyError(sessionId, msg, `Unsupported language "${cmd.lang}". Supported: ${langs.join(', ')}`);
        }
        const p = this.ensureParticipant(state, targetWid);
        p.lang = cmd.lang;
        p.source = 'pinned';
        p.pendingLang = undefined;
        p.updatedAt = new Date().toISOString();
        await this.confirm(sessionId, msg, `✅ Set ${targetWid} to ${cmd.lang}.`, state);
        return;
      }
      case 'auto': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const p = this.ensureParticipant(state, targetWid);
        p.source = 'learned';
        p.pendingLang = undefined;
        await this.confirm(sessionId, msg, `✅ ${targetWid} set to auto-detect.`, state);
        return;
      }
      case 'ignore':
      case 'unignore': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const p = this.ensureParticipant(state, targetWid);
        p.enabled = cmd.name === 'unignore';
        await this.confirm(
          sessionId,
          msg,
          `✅ ${cmd.name === 'ignore' ? 'Ignoring' : 'Including'} ${targetWid}.`,
          state,
        );
        return;
      }
      case 'grant':
      case 'revoke': {
        if (!targetWid) return this.replyError(sessionId, msg, this.targetHelp());
        const set = new Set(state.delegatedControllers);
        if (cmd.name === 'grant') set.add(targetWid);
        else set.delete(targetWid);
        state.delegatedControllers = [...set];
        await this.confirm(
          sessionId,
          msg,
          `✅ ${cmd.name === 'grant' ? 'Granted' : 'Revoked'} control for ${targetWid}.`,
          state,
        );
        return;
      }
    }
  }

  private resolveTarget(msg: InboundMessage, target?: CommandTarget): string | null {
    if (!target || target.kind === 'me') return msg.author;
    if (target.kind === 'mention') return msg.mentionedIds[0] ?? null;
    // NOTE: a `<number>` target assumes phone-number JID keying (`<number>@c.us`). Under
    // WhatsApp's newer LID scheme participants may be keyed by an opaque `@lid` id instead,
    // so this constructed wid can fail to match the stored participant. The `@mention` and
    // `me` forms resolve to the actual wid and are robust to LID; prefer them. See spec §16.
    return `${target.number}@c.us`;
  }

  private async safeLanguages(): Promise<string[] | null> {
    try {
      return await this.translator.languages();
    } catch {
      return null; // can't validate — allow
    }
  }

  private async confirm(sessionId: string, msg: InboundMessage, text: string, state: GroupState): Promise<void> {
    await this.store.save(state);
    await this.gateway.sendText(sessionId, msg.chatId, text);
  }

  private replyError(sessionId: string, msg: InboundMessage, text: string): Promise<void> {
    return this.gateway.sendText(sessionId, msg.chatId, text);
  }

  private targetHelp(): string {
    return "⚠️ Couldn't identify that user. Target them by @mention, by phone number, or use 'me' for yourself.";
  }

  /**
   * Decide whether the author may run a state-changing command.
   *
   * WhatsApp hands the author of a group message a `@lid` privacy id, while the group participant list
   * comes back keyed `@c.us`. Those are different user numbers, so no amount of string normalization
   * relates them (see widEquals): a promoted admin simply failed every comparison, and only the group
   * `owner` — which WhatsApp reports in the author's own dialect — was ever recognized. A group created
   * by the bot's own number therefore had NO usable administrator at all, because the owner's messages
   * are fromMe and never reach this code.
   *
   * So when the direct comparison finds nothing, ask the host to resolve the author to its canonical
   * `@c.us` identity and compare again. That second identity is what matches the participant list, and
   * it is equally what a `/tr grant` stored for a delegated controller who was named by phone number.
   *
   * The resolution costs one engine round-trip, so it is spent only on a decision that is otherwise a
   * denial, and the result is memoized: a lid↔phone binding does not change.
   */
  private async authorize(
    sessionId: string,
    msg: InboundMessage,
    state: GroupState,
    admins: string[],
  ): Promise<{ isAdmin: boolean; isController: boolean }> {
    const decide = (identities: string[]) => {
      const isAdmin = admins.some(a => identities.some(id => widEquals(a, id)));
      return {
        isAdmin,
        isController: isAdmin || state.delegatedControllers.some(c => identities.some(id => widEquals(c, id))),
      };
    };

    const direct = decide([msg.author]);
    if (direct.isController) return direct;

    const canonical = await this.canonicalWid(sessionId, msg.author);
    if (!canonical || widEquals(canonical, msg.author)) return direct;

    const resolved = decide([msg.author, canonical]);
    if (resolved.isController) {
      this.logger.debug('author authorized via its canonical identity', {
        action: 'translation_author_canonicalized',
        author: msg.author,
        canonical,
      });
    }
    return resolved;
  }

  /** True when a `/tr help` answer is due in `key` (`${sessionId}:${chatId}`), recording the send.
   *  Bounded the same way as {@link canonicalWid}: oldest-first eviction, never unbounded growth. */
  private helpDue(key: string): boolean {
    const now = Date.now();
    const last = this.helpAt.get(key);
    if (last !== undefined && now - last < HELP_COOLDOWN_MS) return false;
    this.helpAt.delete(key); // re-insert so iteration order tracks recency
    this.helpAt.set(key, now);
    if (this.helpAt.size > MAX_HELP_ENTRIES) {
      const oldest = this.helpAt.keys().next().value;
      if (oldest !== undefined) this.helpAt.delete(oldest);
    }
    return true;
  }

  /** Memoized {@link ChatGateway.resolveCanonicalWid}. A null (unresolvable) answer is cached too —
   *  retrying it on every command would spend a round-trip per denial on a wid the host cannot map. */
  private async canonicalWid(sessionId: string, wid: string): Promise<string | null> {
    const key = `${sessionId}:${wid}`;
    const hit = this.canonicalWids.get(key);
    if (hit !== undefined) return hit;

    const resolved = await this.gateway.resolveCanonicalWid(sessionId, wid);
    // Bounded: one entry per distinct author the plugin has had to resolve. Evict oldest-first (Map
    // preserves insertion order) rather than growing without limit in a busy multi-group deployment.
    if (this.canonicalWids.size >= MAX_CANONICAL_WIDS) {
      const oldest = this.canonicalWids.keys().next().value;
      if (oldest !== undefined) this.canonicalWids.delete(oldest);
    }
    this.canonicalWids.set(key, resolved);
    return resolved;
  }
}
