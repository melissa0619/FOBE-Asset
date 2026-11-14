const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
const baseUrl = configuredBaseUrl.replace(/\/$/, '');


export class FobeApiError extends Error {
  constructor(message, { status, cause } = {}) { super(message); this.name = 'FobeApiError'; this.status = status; this.cause = cause; }
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try { response = await fetch(`${baseUrl}${path}`, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch (cause) { throw new FobeApiError('Unable to reach the asset API gateway. Check Node-RED and its backend connection.', { cause }); }
  let data = null;
  if (response.status !== 204) { try { data = await response.json(); } catch (cause) { throw new FobeApiError('FOBE-API returned invalid JSON.', { status: response.status, cause }); } }
  if (!response.ok) throw new FobeApiError(`FOBE-API request failed (${response.status})${typeof data?.detail === 'string' ? `: ${data.detail}` : ''}`, { status: response.status });
  return data;
}

export const getAssets = () => request('/assets?active_only=true&limit=500');
export const getCollections = () => request('/collections?active_only=true&limit=500');
export const getAsset = id => request(`/assets/${encodeURIComponent(id)}`);
export const getMappings = () => request('/mappings');
export const getMappingStatus = ({ modelKey, globalId }) => request(`/mappings/status?${new URLSearchParams({ model_key: modelKey, ifc_global_id: globalId })}`);
export const createMapping = mapping => request('/mappings', { method: 'POST', body: mapping });
export const deleteMapping = ({ modelKey, globalId }) => request(`/mappings/${encodeURIComponent(modelKey)}/${encodeURIComponent(globalId)}`, { method: 'DELETE' });
export const updateDisplayName = mapping => request('/mappings/display-name', { method: 'PATCH', body: mapping });
