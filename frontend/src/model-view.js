import './model-view.css';
import * as THREE from 'three';
import { createIfcViewer } from './viewer.js';
import { setupModelPicker } from './model-picker.js';
import { getAssets, getCollections, getMappings } from './api.js';
import { makeSearchableSelect } from './searchable-select.js';

const $ = id => document.getElementById(id);
const catalog = [
  { key: 'building', name: 'Building Overview', frag: 'building.frag' },
  { key: 'foyer', name: 'Foyer', frag: 'foyer.frag' },
  { key: 'black', name: 'Black Room', frag: 'black-room.frag' },
  { key: 'white', name: 'White Room', frag: 'white-room.frag' },
  { key: 'research', name: 'Research Room', frag: 'research-room.frag' }
];
const PAGE_SIZE = 20;
const modelPicker = makeSearchableSelect($('model-select'), { placeholder: 'Choose a model' });
const mappingCollectionPicker = makeSearchableSelect($('mapping-collection'));
const assetCollectionPicker = makeSearchableSelect($('asset-collection'));
const state = { viewer: null, activeKey: null, models: new Map(), loads: new Map(), ids: new Map(), assets: [], collections: [], mappings: [], mappingPage: 0, assetPage: 0, picker: null };
const itemName = asset => asset?.name || 'Unnamed itemit asset';
const elementName = element => element?.name || element?.globalId || 'Unnamed IFC element';
const status = value => { $('model-status').textContent = value; };
async function bytes(path) { const response = await fetch(path); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return new Uint8Array(await response.arrayBuffer()); }
async function buildLookup(model, key) {
  const localIds = Array.from(await model.getItemsIdsWithGeometry());
  const guids = await model.getGuidsByLocalIds(localIds);
  const lookup = new Map();
  guids.forEach((globalId, index) => { if (globalId && !lookup.has(globalId)) lookup.set(globalId, localIds[index]); });
  state.ids.set(key, lookup);
}
async function ensureModel(entry) {
  if (state.models.has(entry.key)) return state.models.get(entry.key);
  if (state.loads.has(entry.key)) return state.loads.get(entry.key);
  const task = (async () => {
    const model = await state.viewer.fragments.core.load(await bytes(`${import.meta.env.BASE_URL}fragments/${entry.frag}`), { modelId: entry.key });
    state.models.set(entry.key, model); await buildLookup(model, entry.key); return model;
  })();
  state.loads.set(entry.key, task); try { return await task; } finally { state.loads.delete(entry.key); }
}
async function frameModel(model) {
  if (!model?.box || model.box.isEmpty()) return;
  const sphere = model.box.getBoundingSphere(new THREE.Sphere()); sphere.radius *= 1.25;
  await state.viewer.world.camera.controls.fitToSphere(sphere, true);
  await state.viewer.fragments.core.update(true);
}
async function switchModel(key) {
  const entry = catalog.find(model => model.key === key); if (!entry) return;
  $('viewer-overlay').hidden = false; $('viewer-overlay').textContent = `Loading ${entry.name}…`; status(`Loading ${entry.name}…`);
  try {
    const model = await ensureModel(entry); state.activeKey = key;
    for (const [modelKey, candidate] of state.models) candidate.object.visible = modelKey === key;
    await frameModel(model); $('active-model').textContent = entry.name; $('viewer-overlay').hidden = true; status(`${entry.name} ready`);
  } catch (error) { $('viewer-overlay').textContent = `Unable to load ${entry.name}: ${error.message}`; status('3D model unavailable'); }
}
function mappingForAsset(asset) { return state.mappings.find(mapping => mapping.itemit_item_id === asset.id); }
function collectionIds(asset) { return (asset?.collection_memberships || asset?.collections || []).map(value => typeof value === 'string' ? value : value?.id).filter(Boolean); }
function inCollection(asset, collectionId) { return !collectionId || collectionIds(asset).includes(collectionId); }
function setPageControls(prefix, page, totalPages, onPrevious, onNext) {
  $(`${prefix}-page`).textContent = `Page ${page + 1} of ${totalPages}`;
  $(`${prefix}-previous`).disabled = page === 0; $(`${prefix}-next`).disabled = page >= totalPages - 1;
  $(`${prefix}-previous`).onclick = onPrevious; $(`${prefix}-next`).onclick = onNext;
}
function renderAssets() {
  const query = $('asset-search').value.trim().toLowerCase(); const collection = $('asset-collection').value;
  const filtered = state.assets.filter(asset => !mappingForAsset(asset) && inCollection(asset, collection) && (!query || [asset.name, asset.serial, asset.current_location].some(value => String(value || '').toLowerCase().includes(query))));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.assetPage = Math.min(state.assetPage, totalPages - 1);
  const visible = filtered.slice(state.assetPage * PAGE_SIZE, (state.assetPage + 1) * PAGE_SIZE);
  $('asset-count').textContent = `${filtered.length} available`; renderAssetGroup($('unmapped-assets'), visible);
  setPageControls('asset', state.assetPage, totalPages, () => { state.assetPage -= 1; renderAssets(); }, () => { state.assetPage += 1; renderAssets(); });
}
function renderAssetGroup(container, assets) {
  container.replaceChildren(); if (!assets.length) { container.textContent = 'No unmapped assets match these filters.'; return; }
  for (const asset of assets) { const button = document.createElement('div'); button.className = 'asset-row'; button.innerHTML = `<strong>${escapeHtml(itemName(asset))}</strong><span>${escapeHtml(asset.serial || 'No serial')} · ${escapeHtml(asset.current_location || 'No location')}</span><em class="unmapped">Not mapped</em>`; container.append(button); }
}
function renderMappings() {
  const query = $('mapping-search').value.trim().toLowerCase(); const collection = $('mapping-collection').value;
  const filtered = state.mappings.filter(mapping => { const asset = state.assets.find(item => item.id === mapping.itemit_item_id); return inCollection(asset, collection) && (!query || [itemName(asset), asset?.serial, mapping.model_key, mapping.ifc_global_id].some(value => String(value || '').toLowerCase().includes(query))); });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.mappingPage = Math.min(state.mappingPage, totalPages - 1); const visible = filtered.slice(state.mappingPage * PAGE_SIZE, (state.mappingPage + 1) * PAGE_SIZE);
  const container = $('mapping-list'); container.replaceChildren(); $('mapping-count').textContent = `${filtered.length} confirmed`;
  if (!visible.length) container.textContent = 'No confirmed mappings match these filters.';
  for (const mapping of visible) { const asset = state.assets.find(item => item.id === mapping.itemit_item_id); const button = document.createElement('button'); button.className = 'mapping-row'; button.type = 'button'; button.innerHTML = `<strong>${escapeHtml(itemName(asset))}</strong><span>${escapeHtml(mapping.model_key)} · <code>${escapeHtml(mapping.ifc_global_id)}</code></span>`; button.addEventListener('click', () => void focusMapping(mapping, asset)); container.append(button); }
  setPageControls('mapping', state.mappingPage, totalPages, () => { state.mappingPage -= 1; renderMappings(); }, () => { state.mappingPage += 1; renderMappings(); });
}
async function focusMapping(mapping, asset) {
  if (mapping.model_key === 'building') return;
  await switchModel(mapping.model_key); const model = state.models.get(mapping.model_key); const localId = state.ids.get(mapping.model_key)?.get(mapping.ifc_global_id);
  if (localId == null) { status('This mapping exists, but its GlobalId is not present in the loaded model.'); return; }
  await state.picker.select(model, localId); await state.picker.focus(model, localId);
  $('selected-element').textContent = `${itemName(asset)} ↔ ${mapping.ifc_global_id}`;
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }
async function setView(type) {
  const model = state.models.get(state.activeKey); if (!model) return; if (type === 'reset') return frameModel(model);
  const sphere = model.box.getBoundingSphere(new THREE.Sphere()); const center = sphere.center; const distance = Math.max(sphere.radius * 2.5, 10);
  const positions = {
    front: [center.x, center.y + distance * .25, center.z + distance],
    back: [center.x, center.y + distance * .25, center.z - distance],
    left: [center.x - distance, center.y + distance * .25, center.z],
    right: [center.x + distance, center.y + distance * .25, center.z],
    top: [center.x, center.y + distance, center.z]
  };
  const position = positions[type] || positions.front;
  await state.viewer.world.camera.controls.setLookAt(...position, center.x, center.y, center.z, true); await state.viewer.fragments.core.update(true);
}
function setSideTab(id) {
  for (const pane of document.querySelectorAll('.browser-pane')) pane.hidden = pane.id !== id;
  for (const tab of document.querySelectorAll('[data-side-tab]')) { const active = tab.dataset.sideTab === id; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); }
}
function populateFilters() {
  for (const collection of state.collections) { $('mapping-collection').add(new Option(collection.name, collection.id)); $('asset-collection').add(new Option(collection.name, collection.id)); }
  mappingCollectionPicker.refresh(); assetCollectionPicker.refresh();
}
async function start() {
  catalog.forEach(model => $('model-select').add(new Option(model.name, model.key))); modelPicker.refresh();
  $('model-select').addEventListener('change', () => void switchModel($('model-select').value));
  $('asset-search').addEventListener('input', () => { state.assetPage = 0; renderAssets(); }); $('asset-collection').addEventListener('change', () => { state.assetPage = 0; renderAssets(); });
  $('mapping-search').addEventListener('input', () => { state.mappingPage = 0; renderMappings(); }); $('mapping-collection').addEventListener('change', () => { state.mappingPage = 0; renderMappings(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => void setView(button.dataset.view))); document.querySelectorAll('[data-side-tab]').forEach(button => button.addEventListener('click', () => setSideTab(button.dataset.sideTab)));
  try { state.viewer = await createIfcViewer($('viewer')); state.picker = setupModelPicker({ viewer: state.viewer, getActiveModel: () => state.models.get(state.activeKey), onSelected: async (model, localId) => { const globalId = (await model.getGuidsByLocalIds([localId]))[0]; $('selected-element').textContent = globalId ? `Selected IFC GlobalId: ${globalId}` : 'Selected model element'; } }); [state.assets, state.collections, state.mappings] = await Promise.all([getAssets(), getCollections(), getMappings()]); populateFilters(); renderAssets(); renderMappings(); await switchModel('building'); } catch (error) { status(error.message); $('viewer-overlay').textContent = `Viewer failed to start: ${error.message}`; }
}
void start();
