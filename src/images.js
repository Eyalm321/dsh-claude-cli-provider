/**
 * Getting images to `claude -p`.
 *
 * The harness passes images as `{type:'image', attachment: ImageAttachmentRef}` — an opaque
 * id plus metadata, deliberately not bytes or a path. `claude -p` takes a text prompt, so a
 * reference means nothing to it. Until this existed, renderPrompt simply dropped image blocks
 * and the model was asked to explain a screenshot it could not see, with no error anywhere.
 *
 * The bridge is the filesystem: bytes are read from the attachment service, written to a
 * private per-turn directory, and the paths named in the prompt. Claude Code reads image
 * files with its own tools, so this works precisely when tools are NOT isolated — which is
 * the mode where Claude is worth using as an agent at all.
 *
 * @module dsh-claude-cli-provider/images
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
};

/** Every image attachment in a message list, in order. */
export function collectImages(messages = []) {
  const out = [];
  for (const m of messages) {
    for (const b of m.content ?? []) {
      if (b?.type === 'image' && b.attachment) out.push(b.attachment);
    }
  }
  return out;
}

/**
 * Materialise attachments as files and return `{dir, files, cleanup}`.
 *
 * A failure to read one image must not fail the turn: the caller still has the text, which
 * is usually the actual question. Unreadable images are reported, not thrown.
 */
export async function materialise(attachments, readImage, { mkdtempImpl = mkdtemp, writeFileImpl = writeFile, rmImpl = rm } = {}) {
  if (!attachments.length) return { dir: null, files: [], failed: 0, cleanup: async () => {} };
  if (typeof readImage !== 'function') {
    return { dir: null, files: [], failed: attachments.length, cleanup: async () => {} };
  }
  const dir = await mkdtempImpl(join(tmpdir(), 'dsh-claude-img-'));
  const files = [];
  let failed = 0;
  for (const [i, ref] of attachments.entries()) {
    try {
      const bytes = await readImage(ref);
      const name = `image-${i + 1}${EXT[ref.mediaType] ?? '.bin'}`;
      const path = join(dir, name);
      await writeFileImpl(path, bytes, { mode: 0o600 });
      files.push({ path, mediaType: ref.mediaType, width: ref.width, height: ref.height });
    } catch {
      failed += 1;
    }
  }
  return { dir, files, failed, cleanup: async () => { try { await rmImpl(dir, { recursive: true, force: true }); } catch { /* already gone */ } } };
}

/**
 * The prompt section naming the files.
 *
 * Explicit about what to do with them: a path in a prompt is easy to read past, and an agent
 * that ignores the screenshot answers the wrong question confidently.
 */
export function describeImages(files, failed) {
  const parts = [];
  if (files.length) {
    parts.push(
      `${files.length} image${files.length > 1 ? 's' : ''} accompanied this message. `
      + 'Read them before answering — they are the subject of the request:',
      ...files.map((f) => `  ${f.path}  (${f.mediaType}${f.width ? `, ${f.width}x${f.height}` : ''})`),
    );
  }
  if (failed) parts.push(`[${failed} image${failed > 1 ? 's' : ''} could not be read and are not available.]`);
  return parts.join('\n');
}
