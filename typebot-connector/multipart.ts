export interface MultipartField {
  name: string;
  value: string;
}
export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

// Assemble a multipart/form-data body as raw bytes so a binary attachment survives intact (a string body
// would be UTF-8 re-encoded and corrupt non-UTF-8 bytes). Pure — no ctx.
// NOTE: intentionally duplicated per plugin (plugins ship as self-contained zips) — keep all copies in
// sync; scripts/shared-copies.test.mjs fails the build when they drift.
export function buildMultipartBody(boundary: string, fields: MultipartField[], files: MultipartFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of fields) {
    const fieldName = f.name.replace(/[\r\n"]/g, '');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${f.value}\r\n`));
  }
  for (const file of files) {
    // filename + contentType come from attacker-controlled WhatsApp media metadata. Strip CR/LF (and a `"`
    // from field/file names) so they can't break out of the part headers and inject extra multipart parts.
    const fieldName = file.name.replace(/[\r\n"]/g, '');
    const filename = file.filename.replace(/[\r\n"]/g, '');
    const contentType = file.contentType.replace(/[\r\n]/g, '');
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}
