import type { PluginNetResponse, PluginNetRequestInit } from '../types/openwa';

export interface ChatCompletionConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  /** Sent as `max_tokens`; omitted when unset. */
  maxOutputTokens?: number;
  /** Fetch budget; unset leaves the host default (15 s). */
  timeoutMs?: number;
}

// How much of a provider's error body goes into the thrown message, and so into the log line.
const ERROR_BODY_MAX = 200;

/**
 * Pure HTTP client for calling OpenAI-compatible Chat Completions.
 * Uses the injected fetchFn (bound to ctx.net.fetch) so it can be tested offline.
 */
export async function fetchChatCompletion(
  fetchFn: (url: string, init?: PluginNetRequestInit) => Promise<PluginNetResponse>,
  config: ChatCompletionConfig,
  userMessage: string
): Promise<string> {
  const url = config.apiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
  
  const messages: Array<{ role: string; content: string }> = [];
  if (config.systemPrompt && config.systemPrompt.trim()) {
    messages.push({ role: 'system', content: config.systemPrompt.trim() });
  }
  messages.push({ role: 'user', content: userMessage });

  const payload = JSON.stringify({
    model: config.model,
    messages,
    ...(config.maxOutputTokens ? { max_tokens: config.maxOutputTokens } : {}),
  });

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: payload,
    timeoutMs: config.timeoutMs,
  });

  if (!response.ok) {
    // A provider or a proxy in front of it can echo the key back in an error body. Redact before
    // slicing, so a key straddling the cut cannot leave a prefix behind.
    const body = config.apiKey ? response.body.split(config.apiKey).join('***') : response.body;
    throw new Error(`AI API failed with status ${response.status}: ${body.slice(0, ERROR_BODY_MAX)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(response.body);
  } catch (err) {
    throw new Error('AI API returned invalid JSON');
  }

  const replyText = parsed.choices?.[0]?.message?.content;
  if (typeof replyText !== 'string' || !replyText.trim()) {
    throw new Error('AI API returned an empty or malformed reply');
  }

  return replyText;
}
