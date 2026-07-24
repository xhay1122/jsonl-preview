import * as esbuild from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { readFile, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const analyze = process.argv.includes('--analyze');
const common = { bundle: true, sourcemap: watch, minify: false, logLevel: 'info', mainFields: ['module', 'main'] };
const sourceMaps = [
  'dist/extension.js.map',
  'dist/worker.js.map',
  'dist/webview.js.map',
  'dist/webview.css.map'
];
const tailwindPlugin = {
  name: 'tailwind-css',
  setup(build) {
    build.onLoad({ filter: /src[\\/]webview[\\/]styles\.css$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const result = await postcss([tailwindcss()]).process(source, { from: args.path });
      return { contents: result.css, loader: 'css', watchFiles: result.messages.flatMap((message) => message.type === 'dependency' ? [message.file] : []) };
    });
  }
};
if (!watch) {
  await Promise.all(sourceMaps.map((sourceMap) => rm(sourceMap, { force: true })));
}
const extension = {
  ...common, platform: 'node', format: 'cjs', target: 'node20',
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode']
};
const worker = {
  ...common, platform: 'node', format: 'cjs', target: 'node20',
  entryPoints: ['src/worker/workerMain.ts'], outfile: 'dist/worker.js'
};
const webview = {
  ...common, platform: 'browser', format: 'iife', target: 'es2022',
  entryPoints: ['src/webview/main.tsx'], outfile: 'dist/webview.js', plugins: [tailwindPlugin], metafile: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') }, minify: !watch
};
if (watch) {
  const contexts = await Promise.all([extension, worker, webview].map(esbuild.context));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  const results = await Promise.all([extension, worker, webview].map(esbuild.build));
  if (analyze) console.log(await esbuild.analyzeMetafile(results[2].metafile, { verbose: false }));
}
