import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const name of ['index.html', 'style.css', 'isolate.js', 'models.json']) {
  await cp(`site/${name}`, `dist/${name}`);
}
await build({ entryPoints: ['site/app.mjs', 'site/worker.mjs'], outdir: 'dist', bundle: true,
  splitting: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]', outExtension: { '.js': '.mjs' },
  external: ['node:*'], logLevel: 'info' });
await writeFile('dist/.nojekyll', '');
const digest=createHash('sha256');
for(const f of ['site/worker.mjs','site/core.mjs','package-lock.json'])digest.update(await readFile(f));
await writeFile('dist/build-info.json',JSON.stringify({implementation:digest.digest('hex'),built:new Date().toISOString(),commit:process.env.GITHUB_SHA??null}));
