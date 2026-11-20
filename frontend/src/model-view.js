import './model-view.css';
import * as THREE from 'three';
import { createIfcViewer } from './viewer.js';
import { setupModelPicker } from './model-picker.js';
import { downloadMappedAssetsCsv, getAssets, getCollections, getMappings } from './api.js';
import { isExcludedIfcEntity, isNonGeometricIfcDefinition, loadIfcIndexes } from './ifc-index.js';
import { mappingForIfc } from './mapping-selection.js';
import { assetHasKnownCollection, assetMatchesCollectionNode, createCollectionHierarchy } from './collection-hierarchy.js';
import { fullIfcDisplayName, mappingDisplayName } from './mapping-presentation.js';
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
const state = { viewer: null, activeKey: null, models: new Map(), loads: new Map(), ids: new Map(), ifcElements: new Map(), assets: [], collections: [], hierarchy: null, mappings: [], mappingsAvailable: false, assetsLoading: true, assetsError: null, collectionsLoading: true, mappingLoading: true, collectionError: null, mappingError: null, mappingNodeId: null, expandedCollectionIds: new Set(), assetNodeId: null, expandedAssetCollectionIds: new Set(), mappingPage: 0, assetPage: 0, picker: null, selectedIfc: null, selectionVersion: 0, suppressViewerSelection: false };
const itemName = asset => asset?.name || 'Unnamed itemit asset';
const elementName = element => element?.name || element?.globalId || 'Unnamed IFC element';
const modelName = key => catalog.find(entry => entry.key === key)?.name || key || 'Unknown model';
const assetIdentifier = asset => asset?.serial || asset?.id || 'Not recorded';
const assetIdentifierLabel = asset => asset?.serial ? 'Serial' : 'itemit ID';
const status = value => { $('model-status').textContent = value; };
function initializeAssetInventoryPanel() {
  const pane = $('assets-pane'); pane.querySelector('h2').textContent = 'Itemit assets'; pane.querySelector('.pane-help').textContent = 'Browse the itemit inventory by collection, name, serial, or location.';
  if (!$('asset-mapping-warning')) { const warning = document.createElement('p'); warning.id = 'asset-mapping-warning'; warning.className = 'asset-mapping-warning'; warning.setAttribute('role', 'status'); warning.hidden = true; $('asset-selection').after(warning); }
}
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
  const element = selectedIndexedElement(); const mapping = state.mappingsAvailable && mappingForIfc(state.mappings, selection.modelKey, selection.ifcGlobalId);
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
function availableAssetsForCollectionNode(nodeId) {
  return state.assets.filter(asset => !nodeId || assetMatchesCollectionNode(asset, state.hierarchy, nodeId));
}
function assetSelectionPath() { return state.assetNodeId && state.hierarchy?.nodes.has(state.assetNodeId) ? state.hierarchy.path(state.assetNodeId).join(' › ') : 'All collections'; }
function renderAssetCollectionTree() {
  const trigger = $('asset-tree-trigger'); const tree = $('asset-tree'); const note = $('asset-hierarchy-note'); const hierarchy = state.hierarchy; const hasHierarchy = Boolean(hierarchy?.roots.length);
  trigger.disabled = state.collectionsLoading || !hasHierarchy; trigger.classList.toggle('is-loading', state.collectionsLoading); trigger.textContent = state.collectionsLoading ? '' : hasHierarchy ? assetSelectionPath() : 'Collections unavailable'; trigger.title = state.collectionsLoading ? 'Loading collections' : assetSelectionPath(); tree.replaceChildren();
  if (state.collectionsLoading) { note.hidden = true; note.replaceChildren(); return; }
  if (!hasHierarchy) { note.hidden = false; note.replaceChildren('Collection hierarchy is unavailable. '); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadMappingData()); note.append(retry); return; }
  const appendNode = (id, depth = 0, ancestors = new Set()) => {
    const node = hierarchy.nodes.get(id); if (!node) return; const children = (hierarchy.children.get(id) || []).filter(child => !ancestors.has(child)); const branch = children.length > 0;
    const row = document.createElement('div'); row.className = 'asset-tree-node'; row.classList.toggle('is-selected', state.assetNodeId === id); row.style.setProperty('--tree-depth', depth);
    const toggle = branch ? document.createElement('button') : document.createElement('span'); toggle.className = branch ? 'asset-tree-toggle' : 'asset-tree-chevron-spacer';
    if (branch) { const expanded = state.expandedAssetCollectionIds.has(id); toggle.type = 'button'; toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${node.name}`); toggle.setAttribute('aria-expanded', String(expanded)); toggle.innerHTML = '<svg class="asset-tree-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>'; if (expanded) toggle.classList.add('is-expanded'); toggle.addEventListener('click', event => { event.stopPropagation(); state.expandedAssetCollectionIds.has(id) ? state.expandedAssetCollectionIds.delete(id) : state.expandedAssetCollectionIds.add(id); renderAssetCollectionTree(); }); } else toggle.setAttribute('aria-hidden', 'true');
    const select = document.createElement('button'); select.type = 'button'; select.className = 'asset-tree-node-label'; select.setAttribute('role', 'treeitem'); select.setAttribute('aria-level', String(depth + 1)); select.setAttribute('aria-selected', String(state.assetNodeId === id)); if (branch) select.setAttribute('aria-expanded', String(state.expandedAssetCollectionIds.has(id))); select.title = hierarchy.path(id).join(' › ');
    const label = document.createElement('span'); label.className = 'asset-tree-node-text'; label.textContent = node.name; const count = document.createElement('span'); count.className = 'asset-tree-node-count'; count.textContent = `(${availableAssetsForCollectionNode(id).length})`; count.setAttribute('aria-label', `${availableAssetsForCollectionNode(id).length} available itemit assets`);
    select.append(label, count); select.addEventListener('click', () => { state.assetNodeId = id; state.assetPage = 0; $('asset-tree-popover').hidden = true; trigger.setAttribute('aria-expanded', 'false'); renderAssetCollectionTree(); renderAssets(); trigger.focus(); }); row.append(toggle, select); tree.append(row);
    if (branch && state.expandedAssetCollectionIds.has(id)) children.forEach(child => appendNode(child, depth + 1, new Set([...ancestors, id])));
  };
  hierarchy.roots.forEach(id => appendNode(id));
  if (state.collectionError) { note.hidden = false; note.replaceChildren('Showing the last available hierarchy. '); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadMappingData()); note.append(retry); } else { note.hidden = true; note.replaceChildren(); }
}
const UNCLASSIFIED_NODE_ID = '__unclassified__';
function mappingsForCollectionNode(nodeId) {
  if (nodeId === UNCLASSIFIED_NODE_ID) return state.mappings.filter(mapping => !assetHasKnownCollection(state.assets.find(asset => asset.id === mapping.itemit_item_id), state.hierarchy));
  return state.mappings.filter(mapping => assetMatchesCollectionNode(state.assets.find(asset => asset.id === mapping.itemit_item_id), state.hierarchy, nodeId));
}
function selectedHierarchyNode() { return state.mappingNodeId; }
function selectionPath() {
  if (state.mappingNodeId === UNCLASSIFIED_NODE_ID) return 'Unclassified';
  return state.hierarchy?.nodes.has(state.mappingNodeId) ? state.hierarchy.path(state.mappingNodeId).join(' › ') : 'Select a category';
}
function renderCollectionTree() {
  const trigger = $('mapping-tree-trigger'); const tree = $('mapping-tree'); const note = $('mapping-hierarchy-note'); const hierarchy = state.hierarchy;
  const treeLoading = state.mappingLoading || state.collectionsLoading;
  $('mapping-search').disabled = treeLoading || !state.mappingNodeId;
  const hasHierarchy = Boolean(hierarchy?.roots.length);
  trigger.disabled = treeLoading || !hasHierarchy; trigger.classList.toggle('is-loading', treeLoading);
  trigger.textContent = treeLoading ? '' : !hasHierarchy ? 'Collection hierarchy unavailable' : selectionPath();
  trigger.title = treeLoading ? 'Loading collection hierarchy' : selectionPath();
  tree.replaceChildren();
  if (treeLoading) { note.hidden = true; note.replaceChildren(); return; }
  if (!hasHierarchy) {
    note.hidden = false;
    note.replaceChildren('Collection hierarchy is unavailable. ');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadMappingData()); note.append(retry); return;
  }
  const countFor = id => mappingsForCollectionNode(id).length;
  const appendNode = (id, depth = 0, ancestors = new Set()) => {
    const node = hierarchy.nodes.get(id); if (!node) return;
    const children = (hierarchy.children.get(id) || []).filter(child => !ancestors.has(child)); const branch = children.length > 0;
    const row = document.createElement('div'); row.className = 'mapping-tree-node'; row.classList.toggle('is-selected', state.mappingNodeId === id); row.style.setProperty('--tree-depth', depth);
    const toggle = branch ? document.createElement('button') : document.createElement('span'); toggle.className = branch ? 'tree-toggle' : 'tree-chevron-spacer';
    if (branch) {
      const expanded = state.expandedCollectionIds.has(id); toggle.type = 'button'; toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${node.name}`); toggle.setAttribute('aria-expanded', String(expanded)); toggle.innerHTML = '<svg class="tree-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';
      if (expanded) toggle.classList.add('is-expanded');
      toggle.addEventListener('click', event => { event.stopPropagation(); state.expandedCollectionIds.has(id) ? state.expandedCollectionIds.delete(id) : state.expandedCollectionIds.add(id); renderCollectionTree(); });
    } else toggle.setAttribute('aria-hidden', 'true');
    const select = document.createElement('button'); select.type = 'button'; select.className = 'tree-node-label'; select.setAttribute('role', 'treeitem'); select.setAttribute('aria-level', String(depth + 1)); select.setAttribute('aria-selected', String(state.mappingNodeId === id)); if (branch) select.setAttribute('aria-expanded', String(state.expandedCollectionIds.has(id))); select.title = hierarchy.path(id).join(' › ');
    const label = document.createElement('span'); label.className = 'tree-node-text'; label.textContent = node.name;
    const count = document.createElement('span'); count.className = 'tree-node-count'; count.textContent = `(${countFor(id)})`; count.setAttribute('aria-label', `${countFor(id)} confirmed mappings`);
    select.append(label, count); select.addEventListener('click', () => { state.mappingNodeId = id; state.mappingPage = 0; $('mapping-tree-popover').hidden = true; trigger.setAttribute('aria-expanded', 'false'); renderCollectionTree(); renderMappings(); trigger.focus(); });
    row.append(toggle, select); tree.append(row);
    if (branch && state.expandedCollectionIds.has(id)) children.forEach(child => appendNode(child, depth + 1, new Set([...ancestors, id])));
  };
  hierarchy.roots.forEach(id => appendNode(id));
  const unclassified = countFor(UNCLASSIFIED_NODE_ID);
  if (unclassified) { const row = document.createElement('div'); row.className = 'mapping-tree-node unclassified-node'; row.classList.toggle('is-selected', state.mappingNodeId === UNCLASSIFIED_NODE_ID); const spacer = document.createElement('span'); spacer.className = 'tree-chevron-spacer'; spacer.setAttribute('aria-hidden', 'true'); const select = document.createElement('button'); select.type = 'button'; select.className = 'tree-node-label'; select.setAttribute('role', 'treeitem'); select.setAttribute('aria-selected', String(state.mappingNodeId === UNCLASSIFIED_NODE_ID)); const label = document.createElement('span'); label.className = 'tree-node-text'; label.textContent = 'Unclassified'; const count = document.createElement('span'); count.className = 'tree-node-count'; count.textContent = `(${unclassified})`; count.setAttribute('aria-label', `${unclassified} confirmed mappings`); select.append(label, count); select.addEventListener('click', () => { state.mappingNodeId = UNCLASSIFIED_NODE_ID; state.mappingPage = 0; $('mapping-tree-popover').hidden = true; trigger.setAttribute('aria-expanded', 'false'); renderCollectionTree(); renderMappings(); trigger.focus(); }); row.append(spacer, select); tree.append(row); }
  if (state.collectionError) {
    note.hidden = false;
    note.replaceChildren('Showing the last available hierarchy. ');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadMappingData()); note.append(retry);
  } else { note.hidden = true; note.replaceChildren(); }
}
function setPageControls(prefix, page, totalPages, onPrevious, onNext) {
  $(`${prefix}-page`).textContent = `Page ${page + 1} of ${totalPages}`;
  $(`${prefix}-previous`).disabled = page === 0; $(`${prefix}-next`).disabled = page >= totalPages - 1;
  $(`${prefix}-previous`).onclick = onPrevious; $(`${prefix}-next`).onclick = onNext;
}
function renderMappingEmptyState(title, description) {
  const container = $('mapping-list'); container.replaceChildren(); container.classList.remove('is-loading', 'soft-loading-list');
  const empty = document.createElement('div'); empty.className = 'mapping-empty-state';
  empty.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5 12 3l8.5 4.5L12 12 3.5 7.5Z"></path><path d="M3.5 12.25 12 16.75l8.5-4.5M3.5 17 12 21.5l8.5-4.5"></path></svg>';
  const heading = document.createElement('strong'); heading.textContent = title;
  const detail = document.createElement('p'); detail.textContent = description;
  empty.append(heading, detail); container.append(empty);
}
function setMappingPagerVisible(visible) { $('mapping-pager').hidden = !visible; }
function renderMappingTotal() { $('mapping-count').textContent = state.mappingLoading ? '' : `${state.mappings.length} confirmed`; }
function renderLoadingCards(container, kind, message, count) {
  container.replaceChildren(); container.classList.remove('is-loading'); container.classList.add('soft-loading-list');
  const label = document.createElement('p'); label.className = 'soft-loading-message'; label.textContent = message; container.append(label);
  for (let index = 0; index < count; index += 1) { const card = document.createElement('div'); card.className = `soft-skeleton-card ${kind}`; card.setAttribute('aria-hidden', 'true'); card.innerHTML = '<span></span><span></span><span></span>'; container.append(card); }
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
  const warning = $('asset-mapping-warning'); warning.replaceChildren();
  if (state.mappingError) { warning.hidden = false; warning.append('Mapping status temporarily unavailable. '); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadMappingStatus()); warning.append(retry); } else warning.hidden = true;
  const container = $('unmapped-assets');
  if (state.assetsLoading && !state.assets.length) {
    renderLoadingCards(container, 'asset', 'Loading itemit assets...', 4); $('asset-count').textContent = ''; $('asset-previous').parentElement.hidden = true; setPageControls('asset', 0, 1, () => {}, () => {}); return;
  }
  if (state.assetsError && !state.assets.length) {
    container.replaceChildren(); container.classList.remove('is-loading', 'soft-loading-list'); const message = document.createElement('span'); message.textContent = 'Itemit assets could not be loaded.'; const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadInventoryAssets()); container.append(message, retry); $('asset-count').textContent = 'Unavailable'; $('asset-previous').parentElement.hidden = true; setPageControls('asset', 0, 1, () => {}, () => {}); return;
  }
  const query = $('asset-search').value.trim().toLowerCase();
  const filtered = availableAssetsForCollectionNode(state.assetNodeId).filter(asset => !query || [asset.name, asset.serial, asset.current_location].some(value => String(value || '').toLowerCase().includes(query)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.assetPage = Math.min(state.assetPage, totalPages - 1);
  const visible = filtered.slice(state.assetPage * PAGE_SIZE, (state.assetPage + 1) * PAGE_SIZE);
  container.classList.remove('is-loading', 'soft-loading-list'); $('asset-count').textContent = `${filtered.length} assets`; $('asset-previous').parentElement.hidden = false; renderAssetGroup(container, visible);
  setPageControls('asset', state.assetPage, totalPages, () => { state.assetPage -= 1; renderAssets(); }, () => { state.assetPage += 1; renderAssets(); });
}
function renderAssetGroup(container, assets) {
  container.replaceChildren(); if (!assets.length) { container.textContent = 'No itemit assets match these filters.'; return; }
  for (const asset of assets) {
    const card = document.createElement('article'); card.className = 'asset-row';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'asset-row-main'; open.title = 'Open Asset Mapping with this itemit asset selected';
    const mapped = state.mappingsAvailable && mappingForAsset(asset); const mappingStatus = state.mappingsAvailable ? (mapped ? ['Confirmed', 'status-confirmed'] : ['Not mapped', 'status-unmapped']) : ['Unknown', 'status-unknown'];
    open.innerHTML = `<span class="card-heading"><span class="card-label">itemit asset</span><strong>${escapeHtml(itemName(asset))}</strong><em class="status-badge ${mappingStatus[1]}">${mappingStatus[0]}</em></span><span class="asset-field"><span>${escapeHtml(assetIdentifierLabel(asset))}</span><code>${escapeHtml(assetIdentifier(asset))}</code></span><span class="asset-field"><span>Location</span><b>${escapeHtml(asset?.current_location || 'Not recorded')}</b></span>`;
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
  renderMappingTotal();
  if (state.mappingLoading || state.collectionsLoading || state.assetsLoading) {
    renderLoadingCards(container, 'mapping', 'Loading mapping results...', 3);
    setMappingPagerVisible(false);
    setPageControls('mapping', 0, 1, () => {}, () => {});
    return;
  }
  const hierarchy = state.hierarchy; const nodeId = selectedHierarchyNode(); const note = $('mapping-hierarchy-note');
  if (!hierarchy?.roots.length) {
    container.replaceChildren(); container.classList.remove('is-loading', 'soft-loading-list'); container.textContent = 'Collection hierarchy is unavailable, so category filtering cannot be applied.';
    setMappingPagerVisible(false);
    note.textContent = 'Collection hierarchy is unavailable. Confirmed mappings remain unclassified.';
    setPageControls('mapping', 0, 1, () => {}, () => {});
    return;
  }
  if (state.mappingError && !state.mappingsAvailable) {
    container.replaceChildren(); container.classList.remove('is-loading', 'soft-loading-list');
    const message = document.createElement('span'); message.textContent = 'Confirmed mappings could not be loaded.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'tree-retry'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadMappingData());
    container.append(message, retry); $('mapping-count').textContent = 'Unavailable'; setMappingPagerVisible(false);
    note.replaceChildren('Mapping status is unavailable. ', retry.cloneNode(true));
    note.lastElementChild.addEventListener('click', () => void loadMappingData());
    setPageControls('mapping', 0, 1, () => {}, () => {});
    return;
  }
  if (!nodeId) {
    renderMappingEmptyState('No category selected', 'Choose a category above to explore its confirmed mappings.');
    setMappingPagerVisible(false);
    setPageControls('mapping', 0, 1, () => {}, () => {});
    return;
  }
  const query = $('mapping-search').value.trim().toLowerCase();
  const filtered = mappingsForCollectionNode(nodeId).filter(mapping => {
    const asset = state.assets.find(item => item.id === mapping.itemit_item_id);
    return !query || [itemName(asset), asset?.serial, mapping.model_key, mapping.ifc_global_id].some(value => String(value || '').toLowerCase().includes(query));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); state.mappingPage = Math.min(state.mappingPage, totalPages - 1); const visible = filtered.slice(state.mappingPage * PAGE_SIZE, (state.mappingPage + 1) * PAGE_SIZE);
  container.replaceChildren(); container.classList.remove('is-loading', 'soft-loading-list');
  if (!state.collectionError) note.hidden = true;
  if (!visible.length) {
    renderMappingEmptyState(query ? 'No matching results' : 'No confirmed mappings', query ? 'Try a different search term.' : 'There are no confirmed mappings under this category.');
    setMappingPagerVisible(false);
  }
  for (const mapping of visible) {
    const asset = state.assets.find(item => item.id === mapping.itemit_item_id);
    const element = state.ifcElements.get(mapping.model_key)?.get(mapping.ifc_global_id);
    const ifcType = element?.ifcType || mapping.ifc_type || 'IFC type unavailable';
    const ifcName = fullIfcDisplayName(mapping, element);
    const displayName = mappingDisplayName(mapping, asset, element);
    const card = document.createElement('article'); card.className = 'mapping-row';
    const open = document.createElement('button'); open.className = 'mapping-row-main'; open.type = 'button'; open.title = 'Locate this confirmed mapping in the 3D model';
    open.innerHTML = `<span class="mapping-section mapping-summary"><span class="card-heading"><span class="card-label">Mapping display name</span><strong>${escapeHtml(displayName)}</strong><em class="status-badge status-confirmed">Confirmed</em></span></span><span class="mapping-section mapping-asset"><span class="card-label">Linked itemit asset</span><strong>${escapeHtml(itemName(asset))}</strong><span class="asset-field"><span>${escapeHtml(assetIdentifierLabel(asset || { id: mapping.itemit_item_id }))}</span><code>${escapeHtml(assetIdentifier(asset || { id: mapping.itemit_item_id }))}</code></span>${asset?.current_location ? `<span class="asset-field"><span>Location</span><b>${escapeHtml(asset.current_location)}</b></span>` : ''}</span><span class="mapping-section mapping-ifc"><span class="card-label">Linked IFC element</span><strong>${escapeHtml(ifcName || 'IFC name unavailable')}</strong><span class="ifc-type">${escapeHtml(ifcType)}</span><span class="ifc-metadata"><span><b>Model</b>${escapeHtml(modelName(mapping.model_key))}</span><span><b>GlobalId</b><code>${escapeHtml(mapping.ifc_global_id)}</code></span></span></span>`;
    const locate = document.createElement('button'); locate.className = 'locate-action'; locate.type = 'button'; locate.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><path d="M12 3v4M12 17v4M3 12h4M17 12h4"></path></svg><span>Locate in 3D</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"></path></svg>`;
    const locateMapping = () => void focusMapping(mapping, asset);
    open.addEventListener('click', locateMapping); locate.addEventListener('click', locateMapping);
    card.append(open, locate); container.append(card);
  }
  setMappingPagerVisible(filtered.length > PAGE_SIZE);
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
  const url = new URL('./asset-mapping.html', window.location.href);
  url.searchParams.set('asset_id', assetId);
  window.location.assign(url);
}
function navigateToIfcMapping({ modelKey, ifcGlobalId }) {
  const url = new URL('./asset-mapping.html', window.location.href);
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
  state.hierarchy = createCollectionHierarchy(state.collections);
  if (state.mappingNodeId && state.mappingNodeId !== UNCLASSIFIED_NODE_ID && !state.hierarchy.nodes.has(state.mappingNodeId)) state.mappingNodeId = null;
  if (state.assetNodeId && !state.hierarchy.nodes.has(state.assetNodeId)) state.assetNodeId = null;
  renderCollectionTree(); renderAssetCollectionTree();
}
async function loadMappingData() {
  await Promise.allSettled([loadInventoryAssets(), loadCollections(), loadMappingStatus()]);
}
async function loadInventoryAssets() {
  state.assetsLoading = true; state.assetsError = null; renderAssets();
  try { state.assets = await getAssets(); }
  catch (error) { state.assetsError = error; console.warn('Itemit inventory is unavailable.', error); }
  finally { state.assetsLoading = false; renderAssetCollectionTree(); renderAssets(); }
}
async function loadCollections() {
  state.collectionsLoading = true; state.collectionError = null; renderCollectionTree(); renderAssetCollectionTree();
  try { state.collections = await getCollections(); state.hierarchy = createCollectionHierarchy(state.collections); }
  catch (error) { state.collectionError = error; console.warn('Itemit collection hierarchy is unavailable.', error); }
  finally {
    state.collectionsLoading = false;
    if (state.mappingNodeId && state.mappingNodeId !== UNCLASSIFIED_NODE_ID && !state.hierarchy?.nodes.has(state.mappingNodeId)) state.mappingNodeId = null;
    if (state.assetNodeId && !state.hierarchy?.nodes.has(state.assetNodeId)) state.assetNodeId = null;
    renderCollectionTree(); renderAssetCollectionTree(); renderAssets(); renderMappings();
  }
}
async function loadMappingStatus() {
  state.mappingLoading = true; state.mappingError = null; renderCollectionTree(); renderAssets(); renderMappings();
  try { state.mappings = await getMappings(); state.mappingsAvailable = true; }
  catch (error) { state.mappingError = error; state.mappingsAvailable = false; console.warn('Confirmed mapping status is unavailable.', error); }
  finally { state.mappingLoading = false; renderCollectionTree(); renderAssetCollectionTree(); renderAssets(); renderMappings(); }
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
  initializeAssetInventoryPanel();
  catalog.forEach(model => $('model-select').add(new Option(model.name, model.key))); modelPicker.refresh();
  $('model-select').addEventListener('change', () => { clearIfcContext(); void switchModel($('model-select').value); });
  $('asset-search').addEventListener('input', () => { state.assetPage = 0; renderAssets(); });
  $('asset-tree-trigger').addEventListener('click', () => {
    if (state.mappingLoading || !$('asset-tree').childElementCount) return;
    const popover = $('asset-tree-popover'); popover.hidden = !popover.hidden; $('asset-tree-trigger').setAttribute('aria-expanded', String(!popover.hidden));
    if (!popover.hidden) requestAnimationFrame(() => ($('asset-tree').querySelector('[aria-selected="true"]') || $('asset-tree').querySelector('.asset-tree-node-label'))?.focus());
  });
  $('asset-tree-expand').addEventListener('click', () => { state.expandedAssetCollectionIds = new Set(state.hierarchy?.nodes.keys() || []); renderAssetCollectionTree(); });
  $('asset-tree-collapse').addEventListener('click', () => { state.expandedAssetCollectionIds.clear(); renderAssetCollectionTree(); });
  $('asset-tree-clear').addEventListener('click', () => { state.assetNodeId = null; state.assetPage = 0; $('asset-tree-popover').hidden = true; $('asset-tree-trigger').setAttribute('aria-expanded', 'false'); renderAssetCollectionTree(); renderAssets(); });
  $('mapping-search').addEventListener('input', () => { state.mappingPage = 0; renderMappings(); });
  $('mapping-tree-trigger').addEventListener('click', () => {
    if (state.mappingLoading || !$('mapping-tree').childElementCount) return;
    const popover = $('mapping-tree-popover'); popover.hidden = !popover.hidden;
    $('mapping-tree-trigger').setAttribute('aria-expanded', String(!popover.hidden));
    if (!popover.hidden) requestAnimationFrame(() => ($('mapping-tree').querySelector('[aria-selected="true"]') || $('mapping-tree').querySelector('.tree-node-label'))?.focus());
  });
  $('mapping-tree-expand').addEventListener('click', () => { state.expandedCollectionIds = new Set(state.hierarchy?.nodes.keys() || []); renderCollectionTree(); });
  $('mapping-tree-collapse').addEventListener('click', () => { state.expandedCollectionIds.clear(); renderCollectionTree(); });
  $('mapping-tree-clear').addEventListener('click', () => { state.mappingNodeId = null; state.mappingPage = 0; $('mapping-tree-popover').hidden = true; $('mapping-tree-trigger').setAttribute('aria-expanded', 'false'); renderCollectionTree(); renderMappings(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('mapping-tree-popover').hidden) { $('mapping-tree-popover').hidden = true; $('mapping-tree-trigger').setAttribute('aria-expanded', 'false'); $('mapping-tree-trigger').focus(); }
    if (!$('asset-tree-popover').hidden) { $('asset-tree-popover').hidden = true; $('asset-tree-trigger').setAttribute('aria-expanded', 'false'); $('asset-tree-trigger').focus(); }
  });
  document.addEventListener('pointerdown', event => {
    const mappingFilter = document.querySelector('.collection-tree-filter'); const assetFilter = document.querySelector('.asset-collection-filter');
    if (mappingFilter && !mappingFilter.contains(event.target) && !$('mapping-tree-popover').hidden) { $('mapping-tree-popover').hidden = true; $('mapping-tree-trigger').setAttribute('aria-expanded', 'false'); }
    if (assetFilter && !assetFilter.contains(event.target) && !$('asset-tree-popover').hidden) { $('asset-tree-popover').hidden = true; $('asset-tree-trigger').setAttribute('aria-expanded', 'false'); }
  });
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
    renderCollectionTree(); renderAssetCollectionTree(); renderAssets(); renderMappings();
    await switchModel('building');
    void loadMappingData();
  } catch (error) {
    status(error.message); $('viewer-overlay').textContent = `Viewer failed to start: ${error.message}`;
  }
}
void start();
