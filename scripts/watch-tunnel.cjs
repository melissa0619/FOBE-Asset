/* Publish a Cloudflare Quick Tunnel API URL as public GitHub Pages runtime config.
 * Credentials stay in process environment; config/backend.json contains only a public URL. */
const chokidar = require('chokidar');
const dotenv = require('dotenv');
const { readFile, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

const REPOSITORY_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = 'config/backend.json';
const TUNNEL_URL = /https:\/\/[-a-z0-9]+\.trycloudflare\.com\b/gi;

function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }

function normalizeTunnelUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com')) return null;
    return `${url.origin}/api`;
  } catch { return null; }
}

function loadRepositoryEnv({ path = resolve(REPOSITORY_ROOT, '.env'), processEnv = process.env } = {}) {
  return dotenv.config({ path, processEnv, override: false, quiet: true });
}

function updateEnvText(text, apiBaseUrl) {
  const source = String(text ?? '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/(\r?\n)/);
  let found = false;
  let changed = false;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const match = /^(\s*VITE_API_BASE_URL\s*=\s*)(.*)$/.exec(line);
    if (!match) continue;
    found = true;
    const valueAndComment = match[2];
    const commentMatch = /^(.*?)(\s+#.*)?$/.exec(valueAndComment);
    const existingValue = commentMatch[1].trim();
    const quote = existingValue.startsWith('"') && existingValue.endsWith('"') ? '"' : existingValue.startsWith("'") && existingValue.endsWith("'") ? "'" : '';
    const normalizedExisting = quote ? existingValue.slice(1, -1) : existingValue;
    if (normalizedExisting === apiBaseUrl) break;
    lines[index] = `${match[1]}${quote}${apiBaseUrl}${quote}${commentMatch[2] || ''}`;
    changed = true;
    break;
  }
  if (!found) {
    const separator = source && !source.endsWith('\n') && !source.endsWith('\r') ? newline : '';
    return { changed: true, text: `${source}${separator}VITE_API_BASE_URL=${apiBaseUrl}${newline}` };
  }
  return { changed, text: lines.join('') };
}

async function updateEnvApiBaseUrl(apiBaseUrl, { path = resolve(REPOSITORY_ROOT, '.env'), readFileImpl = readFile, writeFileImpl = writeFile } = {}) {
  const source = await readFileImpl(path, 'utf8');
  const result = updateEnvText(source, apiBaseUrl);
  if (result.changed) await writeFileImpl(path, result.text, 'utf8');
  return result.changed;
}

function extractTunnelUrls(text) {
  // cloudflared may wrap a long Quick Tunnel hostname at the terminal width.
  // Compact whitespace only inside a potential tunnel URL, then preserve log order.
  const unwrapped = String(text || '').replace(/https:\/\/[-a-z0-9\s]+\.trycloudflare\.com/gi, candidate => candidate.replace(/\s+/g, ''));
  return [...unwrapped.matchAll(TUNNEL_URL)].map(match => normalizeTunnelUrl(match[0])).filter(Boolean);
}

function decodeTunnelLog(buffer) {
  // Windows PowerShell redirection commonly creates UTF-16LE logs with a BOM.
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const bytes = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < bytes.length; index += 2) [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
    return bytes.toString('utf16le');
  }
  // A BOM is not guaranteed; a high NUL-byte ratio is a safe UTF-16LE signal
  // for the ASCII Cloudflare log format.
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const nulBytes = [...sample].filter(byte => byte === 0).length;
  return sample.length && nulBytes / sample.length > 0.2 ? buffer.toString('utf16le') : buffer.toString('utf8');
}

async function readTunnelLog(path) {
  return decodeTunnelLog(await readFile(path));
}

async function writeLocalRuntimeConfig(config, { path = resolve(REPOSITORY_ROOT, CONFIG_PATH) } = {}) {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function runtimeConfig(apiBaseUrl, now = () => new Date()) {
  return { schemaVersion: 1, apiBaseUrl, updatedAt: now().toISOString() };
}

function isTransientStatus(status) { return status === 408 || status === 429 || status >= 500; }

async function retry(operation, { attempts = 5, delayMs = 500, sleepImpl = sleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      lastError = error;
      if (!error.transient || attempt === attempts - 1) throw error;
      await sleepImpl(Math.min(delayMs * (2 ** attempt), 8_000) + Math.floor(Math.random() * 100));
    }
  }
  throw lastError;
}

async function validateTunnel(apiBaseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, pagesOrigin } = {}) {
  const headers = { Accept: 'application/json' };
  if (pagesOrigin) headers.Origin = pagesOrigin;
  let response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/health`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const error = new Error(`Tunnel health check could not reach ${apiBaseUrl}/health. Confirm Cloudflare forwards /api to Node-RED and FastAPI is running.`); error.cause = cause; error.transient = true; throw error;
  }
  if (!response.ok) {
    const error = new Error(`Tunnel health check returned HTTP ${response.status} from ${apiBaseUrl}/health. Confirm the Node-RED /api proxy removes the prefix correctly.`); error.transient = isTransientStatus(response.status); throw error;
  }
  if (pagesOrigin) {
    const allowedOrigin = response.headers.get('access-control-allow-origin');
    if (allowedOrigin !== '*' && allowedOrigin !== pagesOrigin) throw new Error(`Tunnel health check did not allow the configured GitHub Pages origin (${pagesOrigin}) through CORS.`);
  }
  return true;
}

class GitHubConfigPublisher {
  constructor({ owner, repository, branch = 'main', token, fetchImpl = globalThis.fetch, now = () => new Date(), retryOptions } = {}) {
    if (!owner || !repository || !token) throw new Error('Missing watcher configuration: REPO_OWNER, REPO_NAME, and GITHUB_TOKEN are required. Add them to the repository-root .env or the launching environment.');
    this.owner = owner; this.repository = repository; this.branch = branch; this.token = token;
    this.fetchImpl = fetchImpl; this.now = now; this.retryOptions = retryOptions;
    this.url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${CONFIG_PATH}`;
  }

  headers() { return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'fobe-tunnel-watcher' }; }

  async getCurrent() {
    const response = await this.fetchImpl(`${this.url}?ref=${encodeURIComponent(this.branch)}`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) { const error = new Error(`GitHub publication preflight could not read ${CONFIG_PATH} (HTTP ${response.status}). Check repository name, branch, token Contents permission, and network access.`); error.transient = isTransientStatus(response.status); throw error; }
    const body = await response.json();
    let config = null;
    try { config = JSON.parse(Buffer.from(body.content || '', 'base64').toString('utf8')); } catch { /* Treat malformed public config as replaceable. */ }
    return { sha: body.sha, config };
  }

  async publish(apiBaseUrl) {
    return retry(async () => {
      const current = await this.getCurrent();
      if (current?.config?.apiBaseUrl === apiBaseUrl) return { changed: false, config: current.config };
      const config = runtimeConfig(apiBaseUrl, this.now);
      const body = { message: `chore: update public tunnel endpoint`, content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`).toString('base64'), branch: this.branch, ...(current?.sha ? { sha: current.sha } : {}) };
      const response = await this.fetchImpl(this.url, { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.ok) return { changed: true, config };
      const error = new Error(`GitHub publication of ${CONFIG_PATH} failed with HTTP ${response.status}.`);
      error.transient = isTransientStatus(response.status) || response.status === 409 || response.status === 422;
      throw error;
    }, this.retryOptions);
  }
}

class TunnelWatcherController {
  constructor({ validate = validateTunnel, publish, persistEnv = async () => {}, persist = async () => {}, logger = console } = {}) {
    this.validate = validate; this.publish = publish; this.persistEnv = persistEnv; this.persist = persist; this.logger = logger;
    this.latest = null; this.sequence = 0; this.running = false; this.publishedUrl = null;
  }

  async observe(apiBaseUrl) {
    if (!apiBaseUrl || apiBaseUrl === this.publishedUrl) return;
    this.latest = { apiBaseUrl, sequence: ++this.sequence };
    if (this.running) return;
    this.running = true;
    try {
      while (this.latest) {
        const candidate = this.latest; this.latest = null;
        try {
          await this.validate(candidate.apiBaseUrl);
          if (candidate.sequence !== this.sequence) continue;
          const envChanged = await this.persistEnv(candidate.apiBaseUrl);
          if (envChanged) this.logger.log('Updated local VITE_API_BASE_URL after tunnel validation.');
          if (candidate.sequence !== this.sequence) continue;
          const result = await this.publish(candidate.apiBaseUrl);
          if (candidate.sequence !== this.sequence) continue;
          await this.persist(result.config);
          this.publishedUrl = candidate.apiBaseUrl;
          this.logger.log(result.changed ? `Published public tunnel endpoint: ${candidate.apiBaseUrl}` : 'Tunnel endpoint already published.');
        } catch (error) {
          if (candidate.sequence === this.sequence) this.logger.error(`Tunnel endpoint was not published: ${error.message}`);
        }
      }
    } finally { this.running = false; }
  }
}

async function start() {
  const envResult = loadRepositoryEnv();
  if (envResult.error && envResult.error.code !== 'ENOENT') console.warn(`Watcher could not load .env: ${envResult.error.message}`);
  const logPath = resolve(REPOSITORY_ROOT, process.env.TUNNEL_LOG_PATH || 'logs/tunnel.log');
  const publisher = new GitHubConfigPublisher({ owner: process.env.REPO_OWNER, repository: process.env.REPO_NAME, branch: process.env.GITHUB_BRANCH || 'main', token: process.env.GITHUB_TOKEN });
  const controller = new TunnelWatcherController({ publish: url => publisher.publish(url), persistEnv: url => updateEnvApiBaseUrl(url), persist: config => writeLocalRuntimeConfig(config), validate: url => validateTunnel(url, { pagesOrigin: process.env.GITHUB_PAGES_ORIGIN }) });
  const inspect = async () => {
    try {
      const urls = extractTunnelUrls(await readTunnelLog(logPath));
      const latestUrl = urls.at(-1);
      if (!latestUrl) {
        console.warn(`No complete Cloudflare Quick Tunnel URL found in ${logPath}; waiting for a line containing https://<name>.trycloudflare.com.`);
        return;
      }
      console.log(`Detected latest Cloudflare tunnel endpoint: ${latestUrl}`);
      await controller.observe(latestUrl);
    } catch (error) {
      if (error.code === 'ENOENT') console.warn(`Tunnel log does not exist yet: ${logPath}. Waiting for Cloudflare to create it.`);
      else console.error(`Tunnel log could not be read: ${error.message}`);
    }
  };
  chokidar.watch(logPath, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 } }).on('add', inspect).on('change', inspect).on('error', error => console.error(`Tunnel log watcher failed: ${error.message}`));
  console.log(`Watching tunnel log: ${logPath}`);
}

if (require.main === module) start().catch(error => { console.error(`Tunnel watcher could not start: ${error.message}`); process.exitCode = 1; });

module.exports = { CONFIG_PATH, decodeTunnelLog, extractTunnelUrls, normalizeTunnelUrl, loadRepositoryEnv, readTunnelLog, runtimeConfig, updateEnvApiBaseUrl, updateEnvText, writeLocalRuntimeConfig, retry, validateTunnel, GitHubConfigPublisher, TunnelWatcherController };
