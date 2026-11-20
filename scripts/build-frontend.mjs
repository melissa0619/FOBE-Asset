/** Build only the GitHub Pages output paths; never clear the repository root. */
import { cp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedPaths = [
  'index.html', 'asset-mapping.html', 'model-view.html', 'assets', 'css', 'js', 'images', 'fragments',
  'ifc-index', 'wasm', 'worker.mjs',
];
const buildDirectory = resolve(root, '.frontend-build');

function validateRuntimeConfig(config) {
  const value = config?.apiBaseUrl;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('config/backend.json apiBaseUrl must be an absolute HTTPS URL.');
  }
  if (config?.schemaVersion !== 1 || url.protocol !== 'https:' || url.pathname.replace(/\/$/, '') !== '/api' || url.search || url.hash || Number.isNaN(Date.parse(config.updatedAt || ''))) {
    throw new Error('config/backend.json must contain schemaVersion 1, an HTTPS apiBaseUrl ending in /api, and an ISO updatedAt timestamp.');
  }
  return url.toString().replace(/\/$/, '');
}

validateRuntimeConfig(JSON.parse(await readFile(resolve(root, 'config', 'backend.json'), 'utf8')));

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

for (const path of generatedPaths) {
  await rm(resolve(root, path), { recursive: true, force: true });
}

for (const path of ['index.html', 'asset-mapping.html', 'assets']) {
  await copyIfPresent(resolve(buildDirectory, path), resolve(root, path));
}

for (const directory of ['fragments', 'ifc-index', 'wasm']) {
  await cp(resolve(root, 'public', directory), resolve(root, directory), {
    recursive: true,
  });
}
await cp(resolve(root, 'public', 'worker.mjs'), resolve(root, 'worker.mjs'));
await rm(buildDirectory, { recursive: true, force: true });
