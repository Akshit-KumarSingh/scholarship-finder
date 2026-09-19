/**
 * Paragraph-aware chunking.
 *
 * A fixed slice(i, i+1000) is the naive version and it cuts sentences in half,
 * which hurts retrieval. This packs whole paragraphs up to a target size and
 * carries one trailing paragraph over as overlap, so a rule split across a
 * boundary still appears whole in one chunk.
 */
export function chunkText(text, { target = 900, overlap = 1 } = {}) {
  const paras = text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 30);

  const chunks = [];
  let buf = [];
  let len = 0;

  for (const p of paras) {
    if (len + p.length > target && buf.length) {
      chunks.push(buf.join("\n\n"));
      buf = buf.slice(-overlap);
      len = buf.reduce((s, x) => s + x.length, 0);
    }
    buf.push(p);
    len += p.length;
  }
  if (buf.length) chunks.push(buf.join("\n\n"));

  return chunks;
}

/**
 * Chunk a scheme's prose sections, tagging each chunk with its section.
 * The section tag lets you filter retrieval — a "what documents do I need"
 * question searches only section:"documents", which sharply improves hits.
 */
export function chunkScheme(scheme) {
  const out = [];
  for (const [section, body] of Object.entries(scheme.sections || {})) {
    if (!body || !body.trim()) continue;
    for (const text of chunkText(body)) {
      out.push({
        scheme_id: scheme.id,
        scheme_name: scheme.name,
        section,
        text,
      });
    }
  }
  return out;
}
