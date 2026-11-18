import './model-view.css';
import * as THREE from 'three';
import { createIfcViewer } from './viewer.js';
import { setupModelPicker } from './model-picker.js';
import { downloadMappedAssetsCsv, getAssets, getCollections, getMappings } from './api.js';
import { isExcludedIfcEntity, isNonGeometricIfcDefinition, loadIfcIndexes } from './ifc-index.js';
import { mappedIfcDisplayName, mappingForIfc } from './mapping-selection.js';
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
const modelPicker = makeSearchableSelect($('model-select'), { placeholder: 'Choose a model', searchable: false });
const mappingCollectionPicker = makeSearchableSelect($('mapping-collection'), { placeholder: 'All collections', searchable: false });
const assetCollectionPicker = makeSearchableSelect($('asset-collection'), { placeholder: 'All collections', searchable: false });
const state = { viewer: null, activeKey: null, models: new Map(), loads: new Map(), ids: new Map(), ifcElements: new Map(), assets: [], collections: [], mappings: [], mappingsAvailable: false, mappingLoading: true, mappingPage: 0, assetPage: 0, picker: null, selectedIfc: null, selectionVersion: 0, suppressViewerSelection: false };
const itemName = asset => asset?.name || 'Unnamed itemit asset';
const elementName = element => element?.name || element?.globalId || 'Unnamed IFC element';
const modelName = key => catalog.find(entry => entry.key === key)?.name || key || 'Unknown model';
const assetIdentifier = asset => asset?.serial || asset?.id || 'Not recorded';
const assetIdentifierLabel = asset => asset?.serial ? 'Serial' : 'itemit ID';
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
    await state.viewer.fragments.core.update(true);
    await frameModel(model); $('active-model').textContent = entry.name; $('viewer-overlay').hidden = true; status(`${entry.name} ready`); return model;
  } catch (error) { $('viewer-overlay').textContent = `Unable to load ${entry.name}: ${error.message}`; status('3D model unavailable'); return null; }
}
function mappingForAsset(asset) { return state.mappings.find(mapping => mapping.itemit_item_id === asset.id); }
function selectedIndexedElement() {
  const selection = state.selectedIfc;
  return selection && state.ifcElements.get(selection.modelKey)?.get(selection.ifcGlobalId);
}
function renderAssetSelection() {
  const container = $('asset-selection'); const selection = state.selectedIfc;
  if (!selection) { container.hidden = true; container.replaceChildren(); container.removeAttribute('role'); container.removeAttribute('tabindex'); container.removeAttribute('title'); container.onclick = null; container.onkeydown = null; return; }
  const element = selectedIndexedElement(); const mapping = mappingForIfc(state.mappings, selection.modelKey, selection.ifcGlobalId);
  const ifcName = elementName(element || { globalId: selection.ifcGlobalId });
  const ifcType = element?.ifcType || 'IFC type unavailable';
  const ifcDetails = `<span class="selection-ifc"><span class="card-label">Selected IFC element <span class="selection-arrow" aria-hidden="true">→</span></span><strong>${escapeHtml(ifcName)}</strong><span class="ifc-type">${escapeHtml(ifcType)}</span><span class="ifc-metadata"><span><b>Model</b>${escapeHtml(modelName(selection.modelKey))}</span><span><b>GlobalId</b><code>${escapeHtml(selection.ifcGlobalId)}</code></span></span></span>`;
  container.hidden = false;
  if (mapping) {
    const asset = state.assets.find(item => item.id === mapping.itemit_item_id);
    container.className = 'asset-selection selected-linked';
    container.innerHTML = `<span class="card-heading"><span class="card-label">Confirmed linked asset</span><strong>${escapeHtml(itemName(asset))}</strong><em class="status-badge status-confirmed">Confirmed</em></span><span class="asset-field"><span>${escapeHtml(assetIdentifierLabel(asset || { id: mapping.itemit_item_id }))}</span><code>${escapeHtml(assetIdentifier(asset || { id: mapping.itemit_item_id }))}</code></span><span class="asset-field"><span>Location</span><b>${escapeHtml(asset?.current_location || 'Not recorded')}</b></span>${ifcDetails}`;
    makeSelectedIfcCardNavigable(container, selection);
    return;
  }
  const excluded = isExcludedIfcEntity(element?.ifcType);
  container.className = `asset-selection${excluded ? ' selection-ineligible' : ''}`;
  const explanation = excluded
    ? 'This IFC entity is not eligible for a new asset mapping because it is a definition, spatial, metadata, or reference entity.'
    : state.mappingLoading
      ? 'Checking confirmed mapping status…'
      : state.mappingsAvailable
        ? 'No confirmed itemit mapping exists for this IFC element. Browse the unmapped assets below to continue in Asset Mapping.'
        : 'Confirmed mapping status is currently unavailable. The unmapped assets below remain available for browsing.';
  container.innerHTML = `${ifcDetails}<p>${explanation}</p>`;
  makeSelectedIfcCardNavigable(container, selection);
}
function selectIfcContext(modelKey, ifcGlobalId) {
  state.selectionVersion += 1;
  state.selectedIfc = modelKey && ifcGlobalId ? { modelKey, ifcGlobalId, version: state.selectionVersion } : null;
  setSideTab('assets-pane'); renderAssets();
}
function clearIfcContext() { selectIfcContext(null, null); }
function collectionIds(asset) { return (asset?.collection_memberships || asset?.collections || []).map(value => typeof value === 'string' ? value : value?.id).filter(Boolean); }
function inCollection(asset, collectionId) { return !collectionId || collectionIds(asset).includes(collectionId); }
function setPageControls(prefix, page, totalPages, onPrevious, onNext) {
  $(`${prefix}-page`).textContent = `Page ${page + 1} of ${totalPages}`;
  $(`${prefix}-previous`).disabled = page === 0; $(`${prefix}-next`).disabled = page >= totalPages - 1;
  $(`${prefix}-previous`).onclick = onPrevious; $(`${prefix}-next`).onclick = onNext;
}
function renderAssets() {
  try {
    renderAssetSelection();
  } catch (error) {
    // A selected-element summary is additive. Never let an unavailable IFC
    // metadata record prevent the normal itemit asset browser from rendering.
    console.warn('[FOBE mapping selection] Unable to render selected IFC context', error);
    const selection = $('asset-selection'); selection.hidden = true; selection.replaceChildren();
  }
  if (!state.mappingsAvailable) {
    $('asset-count').textContent = '';
    $('unmapped-assets').textContent = 'Mapping data is unavailable, so unmapped assets cannot be determined.';
    return;
  }
  const query = $('asset-search').value.trim().toLowerCase(); const collection = $('asset-collection').value;
  const filtered = state.assets.filter(asset => !mappingForAsset(asset) && inCollection(asset, collection) && (!query || [asset.name, asset.serial, asset.current_location].some(value => String(value || '').toLowerCase().includes(query))));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.assetPage = Math.min(state.assetPage, totalPages - 1);
  const visible = filtered.slice(state.assetPage * PAGE_SIZE, (state.assetPage + 1) * PAGE_SIZE);
  const container = $('unmapped-assets');
  $('asset-count').textContent = `${filtered.length} available`; renderAssetGroup(container, visible);
  setPageControls('asset', state.assetPage, totalPages, () => { state.assetPage -= 1; renderAssets(); }, () => { state.assetPage += 1; renderAssets(); });
}
function renderAssetGroup(container, assets) {
  container.replaceChildren(); if (!assets.length) { container.textContent = 'No unmapped assets match these filters.'; return; }
  for (const asset of assets) {
    const card = document.createElement('article'); card.className = 'asset-row';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'asset-row-main'; open.title = 'Open Asset Mapping with this itemit asset selected';
    open.innerHTML = `<span class="card-heading"><span class="card-label">itemit asset</span><strong>${escapeHtml(itemName(asset))}</strong><em class="status-badge status-unmapped">Unmapped</em></span><span class="asset-field"><span>${escapeHtml(assetIdentifierLabel(asset))}</span><code>${escapeHtml(assetIdentifier(asset))}</code></span><span class="asset-field"><span>Location</span><b>${escapeHtml(asset?.current_location || 'Not recorded')}</b></span>`;
    open.addEventListener('click', () => navigateToMapping(asset.id));
    card.append(open);
    const details = assetDetails(asset);
    if (details.length) {
      const more = document.createElement('details'); more.className = 'asset-details';
      more.innerHTML = `<summary>More asset information</summary><dl>${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
      card.append(more);
    }
    container.append(card);
  }
}
function collectionNames(asset) {
  return (asset?.collection_memberships || asset?.collections || [])
    .map(value => typeof value === 'string' ? value : value?.name)
    .filter(Boolean);
}
function assetDetails(asset) {
  const details = [];
  if (asset?.id) details.push(['itemit ID', asset.id]);
  if (asset?.serial) details.push(['Serial', asset.serial]);
  const collections = collectionNames(asset); if (collections.length) details.push(['Collections', collections.join(', ')]);
  if (typeof asset?.is_active === 'boolean') details.push(['Availability', asset.is_active ? 'Active' : 'Inactive']);
  return details;
}
function renderMappings() {
  const container = $('mapping-list');
  if (state.mappingLoading) {
    container.replaceChildren(); container.classList.add('is-loading'); container.textContent = 'Loading confirmed mappings…';
    $('mapping-count').textContent = 'Loading…';
    setPageControls('mapping', 0, 1, () => {}, () => {});
    return;
  }
  const query = $('mapping-search').value.trim().toLowerCase(); const collection = $('mapping-collection').value;
  const filtered = state.mappings.filter(mapping => { const asset = state.assets.find(item => item.id === mapping.itemit_item_id); return inCollection(asset, collection) && (!query || [itemName(asset), asset?.serial, mapping.model_key, mapping.ifc_global_id].some(value => String(value || '').toLowerCase().includes(query))); });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.mappingPage = Math.min(state.mappingPage, totalPages - 1); const visible = filtered.slice(state.mappingPage * PAGE_SIZE, (state.mappingPage + 1) * PAGE_SIZE);
  container.replaceChildren(); container.classList.remove('is-loading'); $('mapping-count').textContent = `${filtered.length} confirmed`;
  if (!visible.length) container.textContent = state.mappingsAvailable ? 'No confirmed mappings match these filters.' : 'Confirmed mappings are currently unavailable.';
  for (const mapping of visible) {
    const asset = state.assets.find(item => item.id === mapping.itemit_item_id);
    const element = state.ifcElements.get(mapping.model_key)?.get(mapping.ifc_global_id);
    const ifcType = element?.ifcType || mapping.ifc_type || 'IFC type unavailable';
    const card = document.createElement('article'); card.className = 'mapping-row';
    const open = document.createElement('button'); open.className = 'mapping-row-main'; open.type = 'button'; open.title = 'Locate this confirmed mapping in the 3D model';
    open.innerHTML = `<span class="mapping-section mapping-asset"><span class="card-heading"><span class="card-label">itemit asset</span><strong>${escapeHtml(itemName(asset))}</strong><em class="status-badge status-confirmed">Confirmed</em></span><span class="asset-field"><span>${escapeHtml(assetIdentifierLabel(asset))}</span><code>${escapeHtml(assetIdentifier(asset || { id: mapping.itemit_item_id }))}</code></span></span><span class="mapping-section mapping-ifc"><span class="card-label">Linked IFC element</span><strong>${escapeHtml(mappedIfcDisplayName(mapping, element))}</strong><span class="ifc-type">${escapeHtml(ifcType)}</span><span class="ifc-metadata"><span><b>Model</b>${escapeHtml(modelName(mapping.model_key))}</span><span><b>GlobalId</b><code>${escapeHtml(mapping.ifc_global_id)}</code></span></span></span>`;
    const locate = document.createElement('button'); locate.className = 'locate-action'; locate.type = 'button'; locate.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><path d="M12 3v4M12 17v4M3 12h4M17 12h4"></path></svg><span>Locate in 3D</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"></path></svg>`;
    const locateMapping = () => void focusMapping(mapping, asset);
    open.addEventListener('click', locateMapping); locate.addEventListener('click', locateMapping);
    card.append(open, locate); container.append(card);
  }
  setPageControls('mapping', state.mappingPage, totalPages, () => { state.mappingPage -= 1; renderMappings(); }, () => { state.mappingPage += 1; renderMappings(); });
}
async function focusMapping(mapping, asset) {
  const indexedElement = state.ifcElements.get(mapping.model_key)?.get(mapping.ifc_global_id);
  const ifcType = indexedElement?.ifcType || mapping.ifc_type || 'Unknown IFC type';
  const trace = (event, detail = {}) => console.info('[FOBE mapping focus]', { event, modelKey: mapping.model_key, ifcGlobalId: mapping.ifc_global_id, ifcType, ...detail });
  trace('requested');
  if (!catalog.some(entry => entry.key === mapping.model_key)) {
    status(`Incorrect model: this mapping refers to unknown model \"${mapping.model_key}\".`);
    return;
  }
  const model = await switchModel(mapping.model_key);
  if (!model || model.modelId !== mapping.model_key) {
    status(`Incorrect model or model unavailable: \"${mapping.model_key}\" could not be loaded.`);
    return;
  }
  let resolvedLocalId;
  try {
    [resolvedLocalId] = await model.getLocalIdsByGuids([mapping.ifc_global_id]);
  } catch (error) {
    console.warn('[FOBE mapping focus]', { event: 'guid-lookup-failed', modelKey: mapping.model_key, ifcGlobalId: mapping.ifc_global_id, ifcType, error: error.message });
    status(`IFC GlobalId lookup failed for \"${mapping.ifc_global_id}\" in model \"${mapping.model_key}\".`);
    return;
  }
  const localId = state.ids.get(mapping.model_key)?.get(mapping.ifc_global_id);
  const geometryAvailable = localId != null;
  trace('resolved', { resolvedLocalId: resolvedLocalId ?? null, geometryLocalId: localId ?? null, geometryAvailable });
  if (isNonGeometricIfcDefinition(indexedElement)) {
    status(`Cannot locate \"${mapping.ifc_global_id}\": ${ifcType} is an IFC type definition and has no physical geometry.`);
    trace('non-renderable-definition', { focusSuccess: false, highlightSuccess: false });
    return;
  }
  if (!geometryAvailable) {
    status(`Geometry unavailable: \"${mapping.ifc_global_id}\" has no renderable geometry in model \"${mapping.model_key}\".`);
    trace('geometry-unavailable', { focusSuccess: false, highlightSuccess: false });
    return;
  }
  try {
    state.suppressViewerSelection = true;
    const focus = await state.picker.locate(model, localId);
    trace('focused', { boxSource: focus.boxSource, boundingBoxDimensions: focus.dimensions, focusRadius: focus.radius, focusSuccess: true });
    trace('highlighted', { highlightSuccess: true });
  } catch (error) {
    if (error.code === 'GEOMETRY_UNAVAILABLE') {
      status(`Geometry unavailable: \"${mapping.ifc_global_id}\" has no renderable geometry in model \"${mapping.model_key}\".`);
    } else if (error.code === 'CAMERA_FAILURE') {
      status(`Camera control failure: unable to focus \"${mapping.ifc_global_id}\".`);
    } else {
      status(`Unable to focus the mapped IFC element: ${error.message}`);
    }
    trace('locate-failed', { focusSuccess: false, highlightSuccess: false, error: error.message });
    return;
  } finally {
    state.suppressViewerSelection = false;
  }
  $('selected-element').textContent = `${itemName(asset)} ↔ ${mapping.ifc_global_id}`;
}
function navigateToMapping(assetId) {
  const url = new URL('./', window.location.href);
  url.searchParams.set('asset_id', assetId);
  window.location.assign(url);
}
function navigateToIfcMapping({ modelKey, ifcGlobalId }) {
  const url = new URL('./', window.location.href);
  url.searchParams.set('model_key', modelKey);
  url.searchParams.set('ifc_global_id', ifcGlobalId);
  window.location.assign(url);
}
function makeSelectedIfcCardNavigable(container, selection) {
  container.setAttribute('role', 'link'); container.tabIndex = 0;
  container.title = 'Open this IFC element in Asset Mapping';
  container.onclick = () => navigateToIfcMapping(selection);
  container.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigateToIfcMapping(selection); }
  };
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
async function loadMappingData() {
  state.mappingLoading = true; renderMappings();
  try {
    const [assetResult, collectionResult, mappingResult] = await Promise.allSettled([getAssets(), getCollections(), getMappings()]);
    if (assetResult.status === 'fulfilled') state.assets = assetResult.value;
    if (collectionResult.status === 'fulfilled') state.collections = collectionResult.value;
    if (mappingResult.status === 'fulfilled') { state.mappings = mappingResult.value; state.mappingsAvailable = true; }
    else state.mappingsAvailable = false;
    if (assetResult.status === 'rejected') throw assetResult.reason;
    if (collectionResult.status === 'rejected' || mappingResult.status === 'rejected') {
      const unavailable = [collectionResult.status === 'rejected' && 'collections', mappingResult.status === 'rejected' && 'mappings'].filter(Boolean).join(' and ');
      console.warn(`Loaded ${state.assets.length} assets, but ${unavailable} are unavailable.`, { collectionResult, mappingResult });
    }
    state.mappingLoading = false; populateFilters(); renderAssets(); renderMappings();
    if (assetResult.status === 'fulfilled' && (collectionResult.status === 'rejected' || mappingResult.status === 'rejected')) {
      status(`${$('model-status').textContent} - Assets loaded; some mapping data is unavailable.`);
    }
  } catch (error) {
    // The 3D models are static GitHub Pages assets. Mapping data is optional
    // because the production site has no local FastAPI proxy.
    state.mappingLoading = false; console.warn('Mapping data is unavailable.', error);
    renderAssets(); renderMappings();
    status($('model-status').textContent + ' · Mapping data unavailable.');
  }
}
async function loadIfcMetadata() {
  try {
    const { indexes } = await loadIfcIndexes();
    state.ifcElements = new Map([...indexes].map(([key, index]) => [
      key,
      new Map(index.elements.map(element => [element.identity.globalId, element]))
    ]));
  } catch (error) {
    // Geometry resolution still works when the static index is unavailable;
    // only the IFC-type-specific error message is unavailable.
    console.warn('[FOBE mapping focus] IFC metadata unavailable', { error: error.message });
  }
}
async function handleViewerSelection(model, localId) {
  if (state.suppressViewerSelection) return;
  const requestVersion = ++state.selectionVersion;
  let ifcGlobalId;
  try { [ifcGlobalId] = await model.getGuidsByLocalIds([localId]); }
  catch (error) { console.warn('[FOBE mapping selection] GlobalId lookup failed', { modelKey: model?.modelId, localId, error: error.message }); return; }
  if (requestVersion !== state.selectionVersion) return;
  $('selected-element').textContent = ifcGlobalId ? `Selected IFC GlobalId: ${ifcGlobalId}` : 'Selected model element';
  if (!ifcGlobalId || !model?.modelId) { clearIfcContext(); return; }
  state.selectedIfc = { modelKey: model.modelId, ifcGlobalId, version: requestVersion };
  setSideTab('assets-pane'); renderAssets();
}
async function start() {
  catalog.forEach(model => $('model-select').add(new Option(model.name, model.key))); modelPicker.refresh();
  $('model-select').addEventListener('change', () => { clearIfcContext(); void switchModel($('model-select').value); });
  $('asset-search').addEventListener('input', () => { state.assetPage = 0; renderAssets(); }); $('asset-collection').addEventListener('change', () => { state.assetPage = 0; renderAssets(); });
  $('mapping-search').addEventListener('input', () => { state.mappingPage = 0; renderMappings(); }); $('mapping-collection').addEventListener('change', () => { state.mappingPage = 0; renderMappings(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => void setView(button.dataset.view))); document.querySelectorAll('[data-side-tab]').forEach(button => button.addEventListener('click', () => setSideTab(button.dataset.sideTab)));
  $('export-mappings-csv').addEventListener('click', async () => {
    const button = $('export-mappings-csv'); button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      const blob = await downloadMappedAssetsCsv(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'mapped-assets.csv'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
      status('Mapping CSV export started.');
    } catch (error) { status(error.message || 'Unable to export mappings as CSV.'); }
    finally { button.disabled = false; button.setAttribute('aria-busy', 'false'); }
  });
  try {
    await loadIfcMetadata();
    state.viewer = await createIfcViewer($('viewer'));
    state.picker = setupModelPicker({ viewer: state.viewer, getActiveModel: () => state.models.get(state.activeKey), onSelected: (model, localId) => { void handleViewerSelection(model, localId); } });
    renderAssets(); renderMappings();
    await switchModel('building');
    void loadMappingData();
  } catch (error) {
    status(error.message); $('viewer-overlay').textContent = `Viewer failed to start: ${error.message}`;
  }
}
void start();
