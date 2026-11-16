const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeTunnelLog, extractTunnelUrls, normalizeTunnelUrl, loadRepositoryEnv, updateEnvApiBaseUrl, updateEnvText, GitHubConfigPublisher, TunnelWatcherController } = require('../../scripts/watch-tunnel.cjs');

test('extracts and normalizes the most recent Cloudflare Quick Tunnel URL', () => {
  assert.deepEqual(extractTunnelUrls('old https://first.trycloudflare.com then https://second.trycloudflare.com'), ['https://first.trycloudflare.com/api', 'https://second.trycloudflare.com/api']);
  assert.equal(normalizeTunnelUrl('http://bad.trycloudflare.com'), null);
});

test('extracts a Quick Tunnel URL split across Cloudflare log lines and keeps the newest URL', () => {
  const log = 'https://older.trycloudflare.com\n2026 INF https://suburban-ruth-fe\nver-highly.trycloudflare.com\n';
  const urls = extractTunnelUrls(log);
  assert.deepEqual(urls, ['https://older.trycloudflare.com/api', 'https://suburban-ruth-fever-highly.trycloudflare.com/api']);
  assert.equal(urls.at(-1), 'https://suburban-ruth-fever-highly.trycloudflare.com/api');
});

test('decodes UTF-16LE Windows PowerShell tunnel logs before extracting URLs', () => {
  const wrapped = 'INF https://newest-ruth-fe\nver.trycloudflare.com\n';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wrapped, 'utf16le')]);
  assert.deepEqual(extractTunnelUrls(decodeTunnelLog(utf16)), ['https://newest-ruth-fever.trycloudflare.com/api']);
});

test('loads watcher configuration from a repository .env file without overwriting process values', () => {
  const environment = { REPO_OWNER: 'already-set' };
  const result = loadRepositoryEnv({ path: require('node:path').join(__dirname, 'fixtures', 'watcher.env'), processEnv: environment });
  assert.equal(result.error, undefined);
  assert.equal(environment.REPO_OWNER, 'already-set');
  assert.equal(environment.REPO_NAME, 'example-repo');
  assert.equal(environment.GITHUB_TOKEN, 'test-token');
});

test('updates only VITE_API_BASE_URL while preserving comments, quoting, and other environment values', () => {
  const source = 'GITHUB_TOKEN=secret\r\nVITE_API_BASE_URL="https://old.trycloudflare.com/api" # fallback\r\nFOBE_FIREBASE_CREDENTIALS=C:\\secure\\firebase.json\r\n';
  const result = updateEnvText(source, 'https://new.trycloudflare.com/api');
  assert.equal(result.changed, true);
  assert.equal(result.text, 'GITHUB_TOKEN=secret\r\nVITE_API_BASE_URL="https://new.trycloudflare.com/api" # fallback\r\nFOBE_FIREBASE_CREDENTIALS=C:\\secure\\firebase.json\r\n');
});

test('appends VITE_API_BASE_URL when missing and avoids a write when unchanged', async () => {
  assert.deepEqual(updateEnvText('REPO_NAME=FOBE-Asset\n', 'https://new.trycloudflare.com/api'), { changed: true, text: 'REPO_NAME=FOBE-Asset\nVITE_API_BASE_URL=https://new.trycloudflare.com/api\n' });
  let writes = 0;
  const changed = await updateEnvApiBaseUrl('https://same.trycloudflare.com/api', { path: 'unused', readFileImpl: async () => 'VITE_API_BASE_URL=https://same.trycloudflare.com/api\n', writeFileImpl: async () => { writes += 1; } });
  assert.equal(changed, false);
  assert.equal(writes, 0);
});

test('publisher skips GitHub updates when the same URL is already published', async () => {
  let puts = 0;
  const publisher = new GitHubConfigPublisher({ owner: 'owner', repository: 'repo', token: 'test', fetchImpl: async (url, options = {}) => {
    if (!options.method) return new Response(JSON.stringify({ sha: 'abc', content: Buffer.from(JSON.stringify({ apiBaseUrl: 'https://same.trycloudflare.com/api' })).toString('base64') }));
    puts += 1; return new Response('{}', { status: 200 });
  } });
  const result = await publisher.publish('https://same.trycloudflare.com/api');
  assert.equal(result.changed, false); assert.equal(puts, 0);
});

test('publisher retries a GitHub SHA conflict before confirming the update', async () => {
  let reads = 0; let puts = 0;
  const publisher = new GitHubConfigPublisher({ owner: 'owner', repository: 'repo', token: 'test', retryOptions: { attempts: 3, delayMs: 0, sleepImpl: async () => {} }, fetchImpl: async (url, options = {}) => {
    if (!options.method) { reads += 1; return new Response(JSON.stringify({ sha: `sha-${reads}`, content: Buffer.from('{}').toString('base64') })); }
    puts += 1; return puts === 1 ? new Response('{}', { status: 409 }) : new Response('{}', { status: 200 });
  } });
  assert.equal((await publisher.publish('https://fresh.trycloudflare.com/api')).changed, true);
  assert.equal(puts, 2); assert.equal(reads, 2);
});

test('publisher retries a transient GitHub API failure', async () => {
  let puts = 0;
  const publisher = new GitHubConfigPublisher({ owner: 'owner', repository: 'repo', token: 'test', retryOptions: { attempts: 3, delayMs: 0, sleepImpl: async () => {} }, fetchImpl: async (url, options = {}) => {
    if (!options.method) return new Response(JSON.stringify({ sha: 'sha', content: Buffer.from('{}').toString('base64') }));
    puts += 1; return puts === 1 ? new Response('{}', { status: 503 }) : new Response('{}', { status: 200 });
  } });
  assert.equal((await publisher.publish('https://retry.trycloudflare.com/api')).changed, true);
  assert.equal(puts, 2);
});

test('rapid observations do not publish a stale tunnel URL', async () => {
  let release; const validated = []; const published = [];
  const pending = new Promise(resolve => { release = resolve; });
  const watcher = new TunnelWatcherController({ logger: { log() {}, error() {} }, validate: async url => { validated.push(url); if (url.includes('old')) await pending; }, publish: async url => { published.push(url); return { changed: true }; } });
  const old = watcher.observe('https://old.trycloudflare.com/api');
  await Promise.resolve();
  const fresh = watcher.observe('https://fresh.trycloudflare.com/api');
  release(); await Promise.all([old, fresh]);
  assert.deepEqual(validated, ['https://old.trycloudflare.com/api', 'https://fresh.trycloudflare.com/api']);
  assert.deepEqual(published, ['https://fresh.trycloudflare.com/api']);
});

test('watcher persists local runtime config only after GitHub confirms publication', async () => {
  const persisted = [];
  const watcher = new TunnelWatcherController({ logger: { log() {}, error() {} }, validate: async () => {}, publish: async url => ({ changed: true, config: { schemaVersion: 1, apiBaseUrl: url, updatedAt: '2026-11-17T00:00:00.000Z' } }), persist: async config => persisted.push(config) });
  await watcher.observe('https://confirmed.trycloudflare.com/api');
  assert.deepEqual(persisted, [{ schemaVersion: 1, apiBaseUrl: 'https://confirmed.trycloudflare.com/api', updatedAt: '2026-11-17T00:00:00.000Z' }]);
});

test('watcher updates local VITE_API_BASE_URL after validation and before GitHub publication', async () => {
  const events = [];
  const watcher = new TunnelWatcherController({ logger: { log() {}, error() {} }, validate: async () => { events.push('validated'); }, persistEnv: async () => { events.push('env'); return true; }, publish: async url => { events.push('published'); return { changed: true, config: { schemaVersion: 1, apiBaseUrl: url, updatedAt: '2026-11-17T00:00:00.000Z' } }; } });
  await watcher.observe('https://validated.trycloudflare.com/api');
  assert.deepEqual(events, ['validated', 'env', 'published']);
});
