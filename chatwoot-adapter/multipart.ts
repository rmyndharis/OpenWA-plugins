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
// would be UTF-8 re-encoded and corrupt non-UTF-8 bytes). Ported from voice-transcription. Pure — no ctx.
export function buildMultipartBody(boundary: string, fields: MultipartField[], files: MultipartFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`));
  }
  for (const file of files) {
    // filename + contentType come from attacker-controlled WhatsApp media metadata. Strip CR/LF (and a `"`
    // from the filename) so they can't break out of the part headers and inject extra multipart parts.
    const filename = file.filename.replace(/[\r\n"]/g, '');
    const contentType = file.contentType.replace(/[\r\n]/g, '');
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}
