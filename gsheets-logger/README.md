# Google Sheets Logger

Logs every emitted WhatsApp message event to a Google Sheet via a Google service account.

## What it logs

One row per event, with columns:

```
timestamp | sessionId | event | direction | chatId | from | to | senderName | isGroup | type | body | messageId | ackStatus | error
```

Events captured: `message:received`, `message:sent`, `message:failed`, and `message:ack` (delivery/read
receipts). Ack rows fill the `messageId` and `ackStatus` columns. Note: `message:ack` is only logged on
OpenWA builds that emit it — older builds never fired the hook, leaving those rows absent.

## Setup

1. **Create a Google Cloud project** and enable the **Google Sheets API**.
2. **Create a service account** and download its **JSON key**.
3. **Create your spreadsheet**, then **share it** with the service account's `client_email` as **Editor**.
4. Note the spreadsheet **ID** from the URL: `https://docs.google.com/spreadsheets/d/<ID>/edit`.

## Install

```bash
node package.mjs gsheets-logger    # produces gsheets-logger.zip

curl -X POST "https://your-openwa-host/plugins/install" \
  -H "X-API-Key: <ADMIN_API_KEY>" -F "file=@gsheets-logger.zip"

curl -X PUT "https://your-openwa-host/plugins/gsheets-logger/config" \
  -H "X-API-Key: <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{ "config": { "spreadsheetId": "<ID>", "serviceAccountJson": "<paste JSON>", "sheetTab": "Logs" } }'

curl -X POST "https://your-openwa-host/plugins/gsheets-logger/enable" \
  -H "X-API-Key: <ADMIN_API_KEY>"
```

## Config reference

| Key | Required | Default | Description |
| --- | -------- | ------- | ----------- |
| `serviceAccountJson` | yes | — | Full service-account key JSON (stored as a secret) |
| `spreadsheetId` | yes | — | Spreadsheet ID from its URL |
| `sheetTab` | no | `Logs` | Target tab name |
| `flushIntervalSec` | no | `5` | Seconds between flushes |
| `flushBatchSize` | no | `20` | Flush early once this many rows are buffered |

## Security

Message content is treated as untrusted. Writes use `valueInputOption=RAW`, so Google Sheets never
evaluates a cell as a formula. As defense-in-depth for CSV export/re-import, cells are also prefixed with
a single quote (`'`) when they start with a formula trigger:

- **ID / enum fields** (chatId, from, to, messageId, status, type): full guard — `=` `+` `-` `@` `\t` `\r`.
- **Free-text fields** (body, senderName, error): guard `=` `@` `\t` `\r` only. `+` and `-` are left intact
  so legitimate content like a phone number (`+62812…`) or `-5` is not corrupted with a leading quote.

## Notes

- Rows are buffered and flushed in batches; on a Sheets error they are retained and retried. The buffer is
  capped at 5000 rows (oldest dropped past the cap, with a warning).
- Requires the target sheet's first tab/`sheetTab` to exist, **with a header row of your choosing** — the
  plugin appends data rows only and does not write a header.
- Append uses `valueInputOption=RAW`, so cell values are stored literally (never evaluated as formulas).

## Operational caveats (current OpenWA runtime)

External plugins run **sandboxed in a worker thread**. Two host limitations affect this plugin until
OpenWA forwards the corresponding lifecycle calls into the worker:

- **Config changes need a re-enable.** Updating config via `PUT /plugins/gsheets-logger/config` persists
  the new values but does not reach the running instance (OpenWA does not yet forward `onConfigChange` to
  sandboxed plugins). **Disable then re-enable** the plugin for new credentials/spreadsheet to take effect.
- **Non-graceful shutdown drops buffered rows.** Already-flushed rows are durable, but rows buffered since
  the last flush (≤ `flushIntervalSec`) are lost if the process is killed without the plugin being disabled
  first, since OpenWA does not currently run `onDisable` on shutdown. Lower `flushIntervalSec` to narrow
  this window.
