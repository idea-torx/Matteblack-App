// Brand IQ — document text extractor.
//
// Accepts a Buffer + mime type (or filename extension) and returns a
// plain-text representation suitable for stuffing into a Claude prompt
// as brand evidence. Supported inputs:
//   - text/plain, text/markdown (.txt, .md): passthrough.
//   - application/pdf (.pdf): pdf-parse text layer.
//   - application/vnd.openxmlformats-officedocument.wordprocessingml.document
//     (.docx): mammoth raw-text extraction.
// Anything else returns { ok: false, error } so the caller can record a
// per-doc extraction status without aborting upload.

const MAX_TEXT_CHARS = 50_000;

export type ExtractResult =
  | { ok: true; text: string; mime: string; truncated: boolean }
  | { ok: false; error: string; mime: string };

function detectMime(filename: string, mime: string | undefined): string {
  const m = (mime || "").toLowerCase();
  if (m) return m;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

function clipText(raw: string): { text: string; truncated: boolean } {
  const collapsed = raw.replace(/\r\n/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n");
  if (collapsed.length <= MAX_TEXT_CHARS) {
    return { text: collapsed, truncated: false };
  }
  return { text: collapsed.slice(0, MAX_TEXT_CHARS), truncated: true };
}

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeHint?: string,
): Promise<ExtractResult> {
  const mime = detectMime(filename, mimeHint);
  try {
    if (mime === "text/plain" || mime === "text/markdown") {
      const raw = buffer.toString("utf-8");
      const { text, truncated } = clipText(raw);
      return { ok: true, text, mime, truncated };
    }
    if (mime === "application/pdf") {
      // pdf-parse uses CommonJS — import via createRequire so the bundled
      // ESM server doesn't choke. Wrap in try/catch separately so a parse
      // failure surfaces as { ok: false } instead of throwing.
      const { default: pdfParse } = (await import("pdf-parse")) as { default: (b: Buffer) => Promise<{ text: string }> };
      const parsed = await pdfParse(buffer);
      const { text, truncated } = clipText(parsed.text || "");
      return { ok: true, text, mime, truncated };
    }
    if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const mammoth = (await import("mammoth")) as unknown as {
        extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      const { value } = await mammoth.extractRawText({ buffer });
      const { text, truncated } = clipText(value || "");
      return { ok: true, text, mime, truncated };
    }
    return { ok: false, error: `Unsupported document type: ${mime}`, mime };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Document extraction failed";
    return { ok: false, error: msg, mime };
  }
}
