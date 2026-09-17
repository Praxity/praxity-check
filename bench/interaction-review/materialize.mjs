import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = await realpath(resolve(here, '../..'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function materialize(destination) {
  const requested = resolve(destination);
  const output = resolve(await realpath(dirname(requested)), basename(requested));
  if (output === repo || output.startsWith(repo + sep)) throw new Error('Output must be outside the repository');
  const manifest = await readFile(resolve(here, 'corpus.json'));
  const corpus = JSON.parse(manifest);
  // mkdir without recursive refuses an existing directory, preserving frozen trials.
  await mkdir(output);
  const records = [];
  for (const item of corpus.cases) {
    const source = await readFile(resolve(here, item.source));
    const html = source.toString().replace(/<title>[\s\S]*?<\/title>/i, `<title>${item.title}</title>`);
    const input = resolve(output, item.id);
    await mkdir(input);
    await writeFile(resolve(input, 'index.html'), html);
    records.push({ ...item, sourceSha256: hash(source), inputSha256: hash(html) });
  }
  await writeFile(resolve(output, 'private-key.json'), JSON.stringify({
    ...corpus,
    manifestSha256: hash(manifest),
    materializerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    cases: records,
  }, null, 2) + '\n');
  return records.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node bench/interaction-review/materialize.mjs NEW_EXTERNAL_DIRECTORY');
    console.log(`Materialized ${await materialize(process.argv[2])} development controls.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
