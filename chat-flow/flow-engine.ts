import type { PluginContext } from '../types/openwa';

export interface FlowNode {
  text: string;
  options?: Record<string, FlowNode>;
}

export interface SessionFlow {
  trigger: string; // e.g. "hi"; empty string = any message triggers
  greeting: string;
  options?: Record<string, FlowNode>;
}

export interface UserState {
  path: string[];
  lastActive: number;
}

export class FlowEngine {
  private static readonly TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes state expiration
  private static readonly MAX_REPROCESS = 1; // bound the invalid-path reset (no unbounded recursion)
  /** Per (session,chat) promise chain serializing the state read→write. Self-evicts when drained. */
  private static readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Process an incoming message and send auto-replies according to `flow` (the resolved per-session
   * config). Returns true if a reply was sent, false otherwise. Serializes per (session, chat) so
   * concurrent messages for the same chat can't interleave the state read→write.
   */
  public static async processMessage(
    context: PluginContext,
    flow: SessionFlow,
    sessionId: string,
    chatId: string,
    messageBody: string,
    messageId: string,
  ): Promise<boolean> {
    // The bounded re-process inside the body calls processLocked directly (bypassing this lock) so a
    // chat never waits on its own still-pending chain entry (self-deadlock). Store a settled tail so a
    // rejection can't wedge the chain, and evict the key once the chain drains.
    const lockKey = `${sessionId}__${chatId}`;
    const prev = this.locks.get(lockKey) ?? Promise.resolve();
    const run = prev.then(() => this.processLocked(context, flow, sessionId, chatId, messageBody, messageId, 0));
    const tail = run.catch(() => {});
    this.locks.set(lockKey, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(lockKey) === tail) this.locks.delete(lockKey);
    }
  }

  private static async processLocked(
    context: PluginContext,
    flow: SessionFlow,
    sessionId: string,
    chatId: string,
    messageBody: string,
    messageId: string,
    depth = 0,
  ): Promise<boolean> {
    context.logger.debug('[FlowEngine] Processing message', { sessionId, chatId, body: messageBody });

    const input = messageBody.trim();
    const stateKey = `state__${sessionId}__${chatId}`.replace(/:/g, '_');
    let state = await context.storage.get<UserState>(stateKey);
    context.logger.debug('[FlowEngine] Loaded state', { stateKey, state });

    // Check expiration
    if (state && Date.now() - state.lastActive > this.TIMEOUT_MS) {
      context.logger.debug('[FlowEngine] Flow state expired', { stateKey });
      await context.storage.delete(stateKey);
      state = null;
    }

    const trigger = flow.trigger.trim();
    const isTriggerWord = trigger !== '' && input.toLowerCase() === trigger.toLowerCase();
    context.logger.debug('[FlowEngine] Trigger check', { trigger, input, isTriggerWord });

    // If no active flow state, check if we should start one
    if (!state) {
      if (trigger !== '' && !isTriggerWord) {
        context.logger.debug('[FlowEngine] No active state and input does not match trigger. Ignoring.');
        return false;
      }
      context.logger.debug('[FlowEngine] Starting new flow', { greeting: flow.greeting });
      await context.messages.reply(sessionId, chatId, messageId, flow.greeting);
      await context.storage.set(stateKey, { path: [], lastActive: Date.now() });
      return true;
    }

    // If trigger word is received while in flow, restart the flow
    if (isTriggerWord) {
      context.logger.debug('[FlowEngine] Trigger word received during active flow. Restarting flow.');
      await context.messages.reply(sessionId, chatId, messageId, flow.greeting);
      await context.storage.set(stateKey, { path: [], lastActive: Date.now() });
      return true;
    }

    // Traverse the configuration options according to the user's path
    let currentNode: FlowNode | undefined = { text: flow.greeting, options: flow.options };

    context.logger.debug('[FlowEngine] Traversing path', { path: state.path });
    for (const key of state.path) {
      if (currentNode && currentNode.options && Object.hasOwn(currentNode.options, key)) {
        currentNode = currentNode.options[key];
      } else {
        // State is invalid (e.g. config changed under the user). Reset, then re-process — bounded.
        context.logger.debug('[FlowEngine] State path invalid (config mismatch). Resetting state.');
        await context.storage.delete(stateKey);
        if (depth >= this.MAX_REPROCESS) {
          context.logger.debug('[FlowEngine] Max reprocess depth reached; not recursing.', { depth });
          return false;
        }
        // Recurse on the locked body, NOT processMessage — re-entering the lock would deadlock on this
        // chat's own still-pending chain entry.
        return this.processLocked(context, flow, sessionId, chatId, messageBody, messageId, depth + 1);
      }
    }

    // Check if user input matches any option of the current node
    context.logger.debug('[FlowEngine] Current node options', {
      options: currentNode.options ? Object.keys(currentNode.options) : null,
    });
    // Object.hasOwn, not a bare `options[input]`: the user-supplied `input` must not match inherited
    // Object.prototype names (e.g. "constructor", "toString", "__proto__"), which would otherwise be a
    // truthy false-match and send `reply(undefined)`.
    const nextNode =
      currentNode.options && Object.hasOwn(currentNode.options, input) ? currentNode.options[input] : undefined;

    if (nextNode) {
      context.logger.debug('[FlowEngine] Input matched option', { input, text: nextNode.text });
      state.path.push(input);
      state.lastActive = Date.now();
      await context.messages.reply(sessionId, chatId, messageId, nextNode.text);

      if (nextNode.options && Object.keys(nextNode.options).length > 0) {
        context.logger.debug('[FlowEngine] Next node has sub-options. Saving updated path.');
        await context.storage.set(stateKey, state);
      } else {
        context.logger.debug('[FlowEngine] Leaf node reached. Clearing flow state.');
        await context.storage.delete(stateKey);
      }
      return true;
    } else if (!currentNode.options || Object.keys(currentNode.options).length === 0) {
      // The resolved node is a leaf with no way forward (config changed under the user). End the flow
      // instead of looping "Invalid option" forever; the next trigger starts cleanly.
      context.logger.debug('[FlowEngine] Resolved node is a dead leaf (config changed). Ending flow.');
      await context.storage.delete(stateKey);
      return false;
    } else {
      context.logger.debug('[FlowEngine] Input did not match any options. Replying with fallback.');
      const invalidMsg = `Invalid option. Please choose one of the available options:\n\n${currentNode.text}`;
      await context.messages.reply(sessionId, chatId, messageId, invalidMsg);
      state.lastActive = Date.now();
      await context.storage.set(stateKey, state);
      return true;
    }
  }
}
