/** Build only the GitHub Pages output paths; never clear the repository root. */
import { cp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedPaths = [
  'index.html', 'model-view.html', 'assets', 'css', 'js', 'images', 'fragments',
  'ifc-index', 'wasm', 'worker.mjs',
];
const buildDirectory = resolve(root, '.frontend-build');

function productionApiBaseUrl() {
  const value = process.env.VITE_API_BASE_URL
    || loadEnv('production', root, 'VITE_').VITE_API_BASE_URL;
  if (!value || !value.trim()) {
    throw new Error('VITE_API_BASE_URL is required for a production build. Set it to the public HTTPS Node-RED gateway URL, including /api.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('VITE_API_BASE_URL must be an absolute HTTP(S) URL.');
  }
  return url.toString().replace(/\/$/, '');
}

const apiBaseUrl = productionApiBaseUrl();

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`Frontend build failed with exit code ${code}`)));
  });
}

async function copyIfPresent(source, destination) {
  try {
    await stat(source);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await cp(source, destination, { recursive: true });
}

await run(process.execPath, [
  resolve(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  'build', '--config', resolve(root, 'vite.config.js'),
]);

const generatedAssetNames = await readdir(resolve(buildDirectory, 'assets'));
const generatedContents = await Promise.all(generatedAssetNames
  .filter(name => name.endsWith('.js'))
  .map(name => readFile(resolve(buildDirectory, 'assets', name), 'utf8')));
if (!generatedContents.some(content => content.includes(apiBaseUrl))) {
  throw new Error('Production bundle does not contain VITE_API_BASE_URL; refusing to publish a build that could fall back to /api.');
}

for (const path of generatedPaths) {
  await rm(resolve(root, path), { recursive: true, force: true });
}

for (const path of ['index.html', 'model-view.html', 'assets']) {
  await copyIfPresent(resolve(buildDirectory, path), resolve(root, path));
}

for (const directory of ['fragments', 'ifc-index', 'wasm']) {
  await cp(resolve(root, 'public', directory), resolve(root, directory), {
    recursive: true,
  });
}
await cp(resolve(root, 'public', 'worker.mjs'), resolve(root, 'worker.mjs'));
await rm(buildDirectory, { recursive: true, force: true });
