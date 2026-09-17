import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { materialize } from './materialize.mjs';

test('materializes isolated inputs, retains key hashes and refuses overwrites', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'interaction-bench-'));
  try {
    const output = join(temp, 'corpus');
    assert.equal(await materialize(output), 16);
    const key = JSON.parse(await readFile(join(output, 'private-key.json')));
    assert.equal(key.split, 'development');
    assert.equal(key.cases.flatMap(item => item.expectedDefects).length, 7);
    for (const item of key.cases) {
      assert.deepEqual(await readdir(join(output, item.id)), ['index.html']);
      assert.match(item.sourceSha256, /^[a-f0-9]{64}$/);
      const html = await readFile(join(output, item.id, 'index.html'), 'utf8');
      assert.ok(html.includes(`<title>${item.title}</title>`));
    }
    await assert.rejects(materialize(output), /EEXIST/);
    await assert.rejects(materialize('bench/interaction-review/output'), /outside the repository/);
    const alias = join(temp, 'repo-alias');
    await symlink(fileURLToPath(new URL('../..', import.meta.url)), alias, 'dir');
    await assert.rejects(materialize(join(alias, 'symlink-output')), /outside the repository/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
