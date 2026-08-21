import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImages, materialise, describeImages } from '../src/images.js';

const ref = (id, mt = 'image/png') => ({ attachmentId: id, mediaType: mt, width: 800, height: 600 });

test('images are collected in order across messages', () => {
  const got = collectImages([
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: ref('1') }] },
    { role: 'user', content: [{ type: 'image', attachment: ref('2') }] },
  ]);
  assert.deepEqual(got.map((r) => r.attachmentId), ['1', '2']);
});

test('messages without images collect nothing', () => {
  assert.deepEqual(collectImages([{ role: 'user', content: [{ type: 'text', text: 'a' }] }]), []);
  assert.deepEqual(collectImages([]), []);
});

test('no reader means images are reported unavailable, never silently dropped', async () => {
  const out = await materialise([ref('1')], undefined);
  assert.equal(out.files.length, 0);
  assert.equal(out.failed, 1, 'the caller must be able to say so in the prompt');
});

test('bytes are written with the right extension for the media type', async () => {
  const written = [];
  const out = await materialise([ref('1', 'image/jpeg'), ref('2', 'image/webp')],
    async () => Buffer.from('x'),
    { mkdtempImpl: async () => '/tmp/probe', writeFileImpl: async (p) => written.push(p), rmImpl: async () => {} });
  assert.deepEqual(written, ['/tmp/probe/image-1.jpg', '/tmp/probe/image-2.webp']);
  assert.equal(out.failed, 0);
});

test('one unreadable image does not lose the others or fail the turn', async () => {
  let n = 0;
  const out = await materialise([ref('1'), ref('2')],
    async () => { n += 1; if (n === 1) throw new Error('gone'); return Buffer.from('x'); },
    { mkdtempImpl: async () => '/tmp/probe', writeFileImpl: async () => {}, rmImpl: async () => {} });
  assert.equal(out.files.length, 1);
  assert.equal(out.failed, 1);
});

test('cleanup removes the whole temp directory', async () => {
  const removed = [];
  const out = await materialise([ref('1')], async () => Buffer.from('x'),
    { mkdtempImpl: async () => '/tmp/probe', writeFileImpl: async () => {}, rmImpl: async (d) => removed.push(d) });
  await out.cleanup();
  assert.deepEqual(removed, ['/tmp/probe']);
});

test('the prompt section tells the model to actually look at them', () => {
  const text = describeImages([{ path: '/tmp/a.png', mediaType: 'image/png', width: 800, height: 600 }], 0);
  assert.match(text, /\/tmp\/a\.png/);
  assert.match(text, /Read them before answering/);
  assert.match(text, /800x600/);
});

test('unreadable images are stated, so the model does not invent what it cannot see', () => {
  assert.match(describeImages([], 2), /2 images could not be read/);
  assert.equal(describeImages([], 0), '');
});
