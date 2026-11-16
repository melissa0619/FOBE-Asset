export class FobeApiError extends Error {
  constructor(message, { status, cause } = {}) { super(message); this.name = 'FobeApiError'; this.status = status; this.cause = cause; }
}

const viteEnv = import.meta.env || {};
export const RUNTIME_CONFIG_TTL_MS = 30_000;

export function runtimeConfigUrl(basePath = '/') {
  const trimmed = String(basePath || '/').replace(/^\/+|\/+$/g, '');
  return `${trimmed ? `/${trimmed}/` : '/'}config/backend.json`;
}

export function normalizeApiBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.pathname.replace(/\/$/, '') !== '/api' || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

export function validateRuntimeConfig(config) {
  const apiBaseUrl = normalizeApiBaseUrl(config?.apiBaseUrl);
  if (!config || config.schemaVersion !== 1 || !apiBaseUrl || Number.isNaN(Date.parse(config.updatedAt || ''))) {
    throw new FobeApiError('Runtime API configuration is missing or invalid. Wait for the tunnel watcher to publish a valid HTTPS /api URL.');
  }
  return { schemaVersion: 1, apiBaseUrl, updatedAt: config.updatedAt };
}

function isPlaceholderRuntimeConfig(config) {
  try { return new URL(config.apiBaseUrl).hostname === 'example.trycloudflare.com'; } catch { return true; }
}

export function createRuntimeConfigResolver({ isDevelopment = false, fallbackBaseUrl = null, basePath = '/', fetchImpl = globalThis.fetch, now = () => Date.now(), ttlMs = RUNTIME_CONFIG_TTL_MS } = {}) {
  let cached = null;
  let expiresAt = 0;
  async function resolve({ forceRefresh = false } = {}) {
    if (isDevelopment) return fallbackBaseUrl || '/api';
    if (!forceRefresh && cached && now() < expiresAt) return cached.apiBaseUrl;
    try {
      const response = await fetchImpl(`${runtimeConfigUrl(basePath)}?runtime=${now()}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`runtime configuration returned HTTP ${response.status}`);
      cached = validateRuntimeConfig(await response.json());
      if (isPlaceholderRuntimeConfig(cached)) throw new Error('runtime configuration has not been published by the tunnel watcher');
      expiresAt = now() + ttlMs;
      return cached.apiBaseUrl;
    } catch (cause) {
      const fallback = normalizeApiBaseUrl(fallbackBaseUrl);
      if (fallback) return fallback;
      throw new FobeApiError('Unable to load the current public API configuration. The Cloudflare tunnel may be offline or its update may still be propagating.', { cause });
    }
  }
  return { resolve, clearCache: () => { cached = null; expiresAt = 0; } };
}

export function createApiClient({ resolver, isDevelopment = false, fallbackBaseUrl = null, fetchImpl = globalThis.fetch } = {}) {
  const configResolver = resolver || createRuntimeConfigResolver({ isDevelopment, fallbackBaseUrl, basePath: viteEnv.BASE_URL || '/', fetchImpl });
  async function request(path, { method = 'GET', body } = {}) {
    let baseUrl = await configResolver.resolve();
    let response;
    const options = { method, cache: 'no-store', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) };
    try { response = await fetchImpl(`${baseUrl}${path}`, options); }
    catch (cause) {
      if (!isDevelopment) {
        try { baseUrl = await configResolver.resolve({ forceRefresh: true }); response = await fetchImpl(`${baseUrl}${path}`, options); }
        catch (refreshCause) { throw new FobeApiError('Unable to reach the asset API gateway after refreshing its tunnel configuration. Check Cloudflare, Node-RED, and the backend connection.', { cause: refreshCause }); }
      } else throw new FobeApiError('Unable to reach the asset API gateway. Check Node-RED and its backend connection.', { cause });
    }
    let data = null;
    if (response.status !== 204) { try { data = await response.json(); } catch (cause) { throw new FobeApiError('FOBE-API returned invalid JSON.', { status: response.status, cause }); } }
    if (!response.ok) throw new FobeApiError(`FOBE-API request failed (${response.status})${typeof data?.detail === 'string' ? `: ${data.detail}` : ''}`, { status: response.status });
    return data;
  }
  return {
    request,
    getAssets: () => request('/assets?active_only=true&limit=500'),
    getCollections: () => request('/collections?active_only=true&limit=500'),
    getAsset: id => request(`/assets/${encodeURIComponent(id)}`),
    getMappings: () => request('/mappings'),
    getMappingStatus: ({ modelKey, globalId }) => request(`/mappings/status?${new URLSearchParams({ model_key: modelKey, ifc_global_id: globalId })}`),
    downloadMappedAssetsCsv: async () => {
      let baseUrl = await configResolver.resolve(); let response;
      try { response = await fetchImpl(`${baseUrl}/mapped-assets.csv`, { cache: 'no-store', headers: { Accept: 'text/csv' } }); }
      catch (cause) {
        if (!isDevelopment) {
          try { baseUrl = await configResolver.resolve({ forceRefresh: true }); response = await fetchImpl(`${baseUrl}/mapped-assets.csv`, { cache: 'no-store', headers: { Accept: 'text/csv' } }); }
          catch (refreshCause) { throw new FobeApiError('Unable to reach the mapping CSV endpoint after refreshing its tunnel configuration. Check Cloudflare, Node-RED, and the backend connection.', { cause: refreshCause }); }
        } else throw new FobeApiError('Unable to reach the asset API gateway. Check Node-RED and its backend connection.', { cause });
      }
      if (!response.ok) { let detail = ''; try { detail = (await response.json())?.detail || ''; } catch { /* The gateway may return non-JSON. */ } throw new FobeApiError(`FOBE-API request failed (${response.status})${typeof detail === 'string' && detail ? `: ${detail}` : ''}`, { status: response.status }); }
      return response.blob();
    },
    createMapping: mapping => request('/mappings', { method: 'POST', body: mapping }),
    deleteMapping: ({ modelKey, globalId }) => request(`/mappings/${encodeURIComponent(modelKey)}/${encodeURIComponent(globalId)}`, { method: 'DELETE' }),
    updateDisplayName: mapping => request('/mappings/display-name', { method: 'PATCH', body: mapping }),
  };
}

const isDevelopment = Boolean(viteEnv.DEV);
// A build-time URL is strictly a development override. Production must use the
// current public runtime config rather than silently falling back to a stale tunnel.
const client = createApiClient({ isDevelopment, fallbackBaseUrl: isDevelopment ? viteEnv.VITE_API_BASE_URL || null : null });
export const getAssets = client.getAssets;
export const getCollections = client.getCollections;
export const getAsset = client.getAsset;
export const getMappings = client.getMappings;
export const getMappingStatus = client.getMappingStatus;
export const downloadMappedAssetsCsv = client.downloadMappedAssetsCsv;
export const createMapping = client.createMapping;
export const deleteMapping = client.deleteMapping;
export const updateDisplayName = client.updateDisplayName;
