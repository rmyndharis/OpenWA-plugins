// Best-effort Markdown → WhatsApp formatting. WhatsApp: *bold*, _italic_, ~strike~, ```mono```.
// Covers the common inline marks; nested/edge Markdown falls through as plain text (acceptable
// for chat bubbles). Upgrade to a real Markdown AST only if flows lean on rich formatting.
export function mdToWhatsApp(md: string): string {
  let s = md;
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');        // links → text (url)
  s = s.replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, '_$1_');   // *italic* → _italic_ (single stars only)
  s = s.replace(/\*\*([^*]+?)\*\*/g, '*$1*');                  // **bold** → *bold* (collapse the doubled marker)
  s = s.replace(/__([^_]+?)__/g, '*$1*');                      // __bold__ → *bold*
  s = s.replace(/~~(.+?)~~/g, '~$1~');                         // ~~strike~~ → ~strike~
  s = s.replace(/`([^`]+)`/g, '$1');                           // `code` → code
  s = s.replace(/^#{1,6}\s+/gm, '');                           // headings → strip leading #
  return s;
}
