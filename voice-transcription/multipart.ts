export interface MultipartField {
  name: string;
  value: string;
}

export interface MultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/**
 * Assemble a multipart/form-data request body as a Buffer. Binary file parts are concatenated as raw
 * bytes (never string-encoded), so audio survives intact across the sandbox→host fetch boundary.
 */
export function buildMultipartBody(
  boundary: string,
  fields: MultipartField[],
  files: MultipartFilePart[],
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`),
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    parts.push(Buffer.from(file.data)); // raw bytes — never string-encoded
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}
