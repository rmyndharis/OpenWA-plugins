# Changelog

## 0.1.0

Initial release — two-way WhatsApp ↔ Chatwoot sync.

- **WhatsApp → Chatwoot:** relays inbound messages (1:1 and groups) into a Chatwoot API-channel inbox as `incoming` messages, including media as attachments. Contacts are keyed on the WhatsApp JID (safe across WhatsApp's `@lid` migration); a group maps to a single synthetic contact with sender-prefixed messages.
- **Chatwoot → WhatsApp:** relays agent replies (`message_type: outgoing`, non-private) back to WhatsApp; drops the adapter's own posts, foreign inboxes, and private notes.
- **Handover:** when a human agent is assigned in Chatwoot, other OpenWA bots stop auto-replying on that chat; automation resumes when the conversation is unassigned.
- Inbound and outbound are serialized by an in-worker per-chat lock (no duplicate contacts/conversations on a cold-start burst), with idempotency on both WhatsApp and Chatwoot message ids.

Requires an OpenWA host with Integration SDK v1 (webhook ingress, `ctx.mappings`, the session+chat handover gate, and `net.allowConfigHosts`), and a Chatwoot version that HMAC-signs account-level webhooks with a timestamp (see the README setup guide).
