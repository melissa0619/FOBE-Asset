import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, createRuntimeConfigResolver, FobeApiError, normalizeApiBaseUrl, runtimeConfigUrl, validateRuntimeConfig } from '../src/api.js';

const validConfig = apiBaseUrl => ({ schemaVersion: 1, apiBaseUrl, updatedAt: '2026-11-16T12:00:00.000Z' });

test('runtime config resolves beneath the GitHub Pages base path', () => {
  assert.equal(runtimeConfigUrl('/FOBE-Asset/'), '/FOBE-Asset/config/backend.json');
  assert.equal(runtimeConfigUrl('/'), '/config/backend.json');
});

test('runtime config accepts only an absolute HTTPS /api endpoint', () => {
  assert.equal(normalizeApiBaseUrl('https://demo.trycloudflare.com/api/'), 'https://demo.trycloudflare.com/api');
  assert.equal(normalizeApiBaseUrl('http://demo.trycloudflare.com/api'), null);
  assert.equal(normalizeApiBaseUrl('https://demo.trycloudflare.com'), null);
  assert.throws(() => validateRuntimeConfig(validConfig('https://demo.trycloudflare.com/not-api')), FobeApiError);
});

test('production resolver caches valid configuration and reports missing configuration', async () => {
  let calls = 0; let now = 1;
  const resolver = createRuntimeConfigResolver({ basePath: '/FOBE-Asset/', now: () => now, fetchImpl: async () => { calls += 1; return new Response(JSON.stringify(validConfig('https://one.trycloudflare.com/api'))); } });
  assert.equal(await resolver.resolve(), 'https://one.trycloudflare.com/api');
  now += 1;
  assert.equal(await resolver.resolve(), 'https://one.trycloudflare.com/api');
  assert.equal(calls, 1);
  await assert.rejects(() => createRuntimeConfigResolver({ fetchImpl: async () => new Response('', { status: 404 }) }).resolve(), FobeApiError);
});

test('placeholder runtime config falls back to the temporary build-time URL', async () => {
  const resolver = createRuntimeConfigResolver({ fallbackBaseUrl: 'https://fallback.trycloudflare.com/api', fetchImpl: async () => new Response(JSON.stringify(validConfig('https://example.trycloudflare.com/api'))) });
  assert.equal(await resolver.resolve(), 'https://fallback.trycloudflare.com/api');
});

test('development resolver preserves the local Vite /api proxy', async () => {
  const resolver = createRuntimeConfigResolver({ isDevelopment: true, fallbackBaseUrl: '/api', fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.equal(await resolver.resolve(), '/api');
});

test('API connection failure refreshes runtime configuration and preserves endpoint paths', async () => {
  let configRead = 0; const requested = [];
  const resolver = createRuntimeConfigResolver({ fetchImpl: async url => {
    configRead += 1;
    return new Response(JSON.stringify(validConfig(configRead === 1 ? 'https://old.trycloudflare.com/api' : 'https://new.trycloudflare.com/api')));
  } });
  const client = createApiClient({ resolver, fetchImpl: async url => {
    requested.push(url);
    if (url.startsWith('https://old.')) throw new TypeError('network failure');
    return new Response(JSON.stringify([]), { status: 200 });
  } });
  assert.deepEqual(await client.getAssets(), []);
  assert.deepEqual(requested, ['https://old.trycloudflare.com/api/assets?active_only=true&limit=500', 'https://new.trycloudflare.com/api/assets?active_only=true&limit=500']);
  assert.equal(configRead, 2);
});

test('production client does not silently use a stale build-time fallback when runtime config is unavailable', async () => {
  const resolver = createRuntimeConfigResolver({ fallbackBaseUrl: null, fetchImpl: async () => new Response('', { status: 404 }) });
  const client = createApiClient({ resolver, fetchImpl: async () => { throw new Error('must not call an old tunnel'); } });
  await assert.rejects(() => client.getAssets(), /Unable to load the current public API configuration/);
});

test('CSV download refreshes runtime config after a tunnel connection failure', async () => {
  let configRead = 0; const requested = [];
  const resolver = createRuntimeConfigResolver({ fetchImpl: async () => new Response(JSON.stringify(validConfig(++configRead === 1 ? 'https://old.trycloudflare.com/api' : 'https://new.trycloudflare.com/api'))) });
  const client = createApiClient({ resolver, fetchImpl: async url => {
    requested.push(url);
    if (url.startsWith('https://old.')) throw new TypeError('network failure');
    return new Response('csv', { status: 200 });
  } });
  assert.equal(await (await client.downloadMappedAssetsCsv()).text(), 'csv');
  assert.deepEqual(requested, ['https://old.trycloudflare.com/api/mapped-assets.csv', 'https://new.trycloudflare.com/api/mapped-assets.csv']);
});
