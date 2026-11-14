import './style.css';
import { createMapping, deleteMapping, getAsset, getAssets, getCollections, getMappingStatus, getMappings, updateDisplayName } from './api.js';
import { loadIfcIndexes, resolveMappingIdentity } from './ifc-index.js';
import { makeSearchableSelect } from './searchable-select.js';
import { createSubmissionGuard, submitMappingEntries } from './confirmation-workflow.js';

const $ = id => document.getElementById(id);
const els = Object.fromEntries(['model', 'ifc-query', 'ifc-scope', 'ifc-status', 'ifc-filter-toggle', 'ifc-filter-panel', 'ifc-list', 'ifc-count', 'ifc-previous', 'ifc-next', 'ifc-page', 'clear-ifc-filters', 'single-mode', 'batch-mode', 'mode-label', 'select-visible', 'select-visible-label', 'review-empty', 'single-review', 'review-guidance', 'ifc-card', 'asset-card', 'batch-queue', 'assign', 'confirm', 'unmap', 'clear-batch', 'asset-query', 'location', 'collection', 'asset-status', 'asset-filter-toggle', 'asset-filter-panel', 'clear-asset-filters', 'active-filters', 'asset-list', 'asset-count', 'previous', 'next', 'page', 'message', 'index-state', 'refresh-data'].map(id => [id, $(id)]));
const state = { indexes: new Map(), assets: [], collections: [], mappings: [], mode: 'single', selectedIfc: null, selectedAsset: null, batch: [], apiAvailable: false, mappingsAvailable: false, page: 0, ifcPage: 0, locationFilterSource: 'auto', editingDisplayName: false, isSubmitting: false, isUnmapping: false };
const runMappingSubmission = createSubmissionGuard();
const runUnmapping = createSubmissionGuard();
const PAGE_SIZE = 25;
const modelPicker = makeSearchableSelect(els.model, { placeholder: 'Choose a model' });
const scopePicker = makeSearchableSelect(els['ifc-scope'], { placeholder: 'Show elements' });
const ifcStatusPicker = makeSearchableSelect(els['ifc-status'], { placeholder: 'All states' });
const locationPicker = makeSearchableSelect(els.location, { placeholder: 'All locations' });
const collectionPicker = makeSearchableSelect(els.collection, { placeholder: 'All collections' });
const assetStatusPicker = makeSearchableSelect(els['asset-status'], { placeholder: 'All states' });
const modelLocation = { white: 'white-box', black: 'black-box', research: 'research-room', foyer: 'foyer' };
const locationKey = location => { const value = String(location || '').toLowerCase(); return value.includes('white') || value.includes('d108g') ? 'white-box' : value.includes('black') || value.includes('d108c') ? 'black-box' : value.includes('research') || value.includes('d108b') ? 'research-room' : value.includes('foyer') ? 'foyer' : 'other'; };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : 'Not available';
const identity = element => element?.identity?.globalId ? element.identity : null;
const keyOf = element => { const id = identity(element); return id && `${id.modelKey}:${id.globalId}`; };
const isActiveMapping = mapping => mapping?.is_mapped === true || (mapping && !Object.hasOwn(mapping, 'is_mapped') && mapping.mapping_status === 'CONFIRMED');
const mappingFor = element => { const id = identity(element); return id && state.mappings.find(row => row.model_key === id.modelKey && row.ifc_global_id === id.globalId && isActiveMapping(row)); };
const isConfirmed = element => Boolean(mappingFor(element));

function message(value = '', tone = '') { els.message.textContent = value; els.message.className = `message ${tone}`; }
function escape(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML; }
function elementName(element) { return String(element?.name || 'Unnamed IFC element').split(':')[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim() || 'Unnamed IFC element'; }
function shortId(value) { const source = String(value || ''); return source.length > 14 ? `${source.slice(0, 8)}…${source.slice(-5)}` : source || 'Not available'; }
function setRecord(node, title, lines) { node.innerHTML = `<span class="record-label">${escape(title)}</span><strong>${escape(lines.shift())}</strong>${lines.map(line => `<span>${escape(line)}</span>`).join('')}`; }
function formatIndexedAt(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'timestamp unavailable' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'UTC', timeZoneName: 'short' }).format(date); }
function refreshConfirm() {
  const active = state.mode === 'batch' ? state.batch.filter(row => row.asset && !isConfirmed(row.element)) : state.selectedIfc && state.selectedAsset && !isConfirmed(state.selectedIfc) ? [{ element: state.selectedIfc, asset: state.selectedAsset }] : [];
  // Inventory can be read without Firestore, but mapping writes require a
  // successful mapping read so existing confirmed mappings remain protected.
  els.confirm.disabled = state.isSubmitting || state.isUnmapping || !state.apiAvailable || !state.mappingsAvailable || active.length === 0;
  els.confirm.textContent = state.isSubmitting ? 'Confirming...' : state.mode === 'batch' ? `Confirm batch (${active.length})` : 'Confirm mapping';
  els.confirm.setAttribute('aria-busy', String(state.isSubmitting));
  els.assign.hidden = state.mode !== 'batch';
  els.assign.disabled = state.mode !== 'batch' || !state.selectedAsset || !state.batch.some(entry => keyOf(entry.element) === keyOf(state.selectedIfc));
  const mapped = state.selectedIfc && mappingFor(state.selectedIfc);
  els.unmap.hidden = !mapped;
  els.unmap.disabled = !mapped || state.isUnmapping || state.isSubmitting || !state.apiAvailable || !state.mappingsAvailable;
  els.unmap.textContent = state.isUnmapping ? 'Unmapping...' : 'Unmap';
  els.unmap.setAttribute('aria-busy', String(state.isUnmapping));
}
function renderIfcCard() {
  els['ifc-card'].hidden = !state.selectedIfc;
  if (!state.selectedIfc) return;
  const element = state.selectedIfc; const mapped = mappingFor(element);
  setRecord(els['ifc-card'], mapped ? 'Confirmed IFC element' : state.mode === 'batch' ? 'Active batch IFC element' : 'Selected IFC element', [elementName(element), `GlobalId: ${identity(element).globalId}`, `Type: ${text(element.ifcType)}`, `Status: ${mapped ? 'Confirmed (locked)' : 'Not mapped'}`, ...(mapped ? [`Linked itemit asset: ${mapped.itemit_item_id}`] : [])]);
}
function renderAssetCard() {
  els['asset-card'].hidden = !state.selectedAsset;
  if (!state.selectedAsset) return;
  const asset = state.selectedAsset;
  setRecord(els['asset-card'], state.mode === 'batch' ? 'Active batch itemit asset' : 'Selected itemit asset', [text(asset.name), `Serial: ${text(asset.serial)}`, `Location: ${text(asset.current_location)}`, `UUID: ${asset.id}`]);
}
function renderDisplayName() {
  const mapped = state.selectedIfc && mappingFor(state.selectedIfc); const visible = Boolean(mapped);
  const view = document.getElementById('display-name-view'); const editor = document.getElementById('display-name-editor');
  if (!view || !editor) return;
  view.hidden = !visible || state.editingDisplayName; editor.hidden = !visible || !state.editingDisplayName;
  if (!visible) return;
  document.getElementById('display-name-value').textContent = text(mapped.display_name);
  if (state.editingDisplayName) document.getElementById('display-name-input').value = mapped.display_name || '';
}
function elementsForCurrentModel() { return state.indexes.get(els.model.value)?.elements || []; }
function eligibleIfc(element) {
  const scope = els['ifc-scope'].value; const mapped = isConfirmed(element);
  if (scope === 'likely' && !mapped && element.candidate?.classification !== 'LIKELY_ASSET') return false;
  if (scope === 'review' && !mapped && element.candidate?.classification === 'BUILDING_COMPONENT') return false;
  const filter = els['ifc-status'].value; if (filter === 'CONFIRMED' && !mapped) return false; if (filter === 'UNMAPPED' && mapped) return false;
  const query = els['ifc-query'].value.trim().toLowerCase();
  return !query || [element.name, element.ifcType, element.tag, identity(element)?.globalId].some(value => String(value || '').toLowerCase().includes(query));
}
function renderIfcList() {
  const elements = elementsForCurrentModel().filter(eligibleIfc); const totalPages = Math.max(1, Math.ceil(elements.length / PAGE_SIZE)); state.ifcPage = Math.min(state.ifcPage, totalPages - 1); const pageElements = elements.slice(state.ifcPage * PAGE_SIZE, (state.ifcPage + 1) * PAGE_SIZE);
  els['ifc-list'].replaceChildren(); els['ifc-count'].textContent = `${elements.length} shown`; els['ifc-page'].textContent = `Page ${state.ifcPage + 1} of ${totalPages}`; els['ifc-previous'].disabled = state.ifcPage === 0; els['ifc-next'].disabled = state.ifcPage >= totalPages - 1;
  const eligible = pageElements.filter(element => !isConfirmed(element));
  els['select-visible-label'].hidden = state.mode !== 'batch'; els['select-visible'].disabled = state.mode !== 'batch' || !eligible.length;
  els['select-visible'].checked = eligible.length > 0 && eligible.every(element => state.batch.some(entry => keyOf(entry.element) === keyOf(element)));
  els['select-visible'].indeterminate = eligible.some(element => state.batch.some(entry => keyOf(entry.element) === keyOf(element))) && !els['select-visible'].checked;
  for (const element of pageElements) {
    const mapped = mappingFor(element); const button = document.createElement('button'); button.type = 'button'; button.className = 'list-row'; button.classList.toggle('selected', keyOf(element) === keyOf(state.selectedIfc)); button.classList.toggle('batch-selected', state.mode === 'batch' && state.batch.some(entry => keyOf(entry.element) === keyOf(element))); button.classList.toggle('locked', Boolean(mapped));
    const status = mapped ? `Confirmed · ${mapped.itemit_item_id}` : 'Not mapped';
    button.innerHTML = `<strong>${escape(elementName(element))}</strong><span>${escape(text(element.ifcType))} · <code>${escape(identity(element).globalId)}</code></span><em class="status-badge ${mapped ? 'status-confirmed' : 'status-unmapped'}">${escape(status)}</em>`;
    button.addEventListener('click', () => selectIfc(element));
    if (state.mode === 'batch') { const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.batch.some(entry => keyOf(entry.element) === keyOf(element)); check.disabled = Boolean(mapped); check.setAttribute('aria-label', `Add ${elementName(element)} to batch`); check.addEventListener('click', event => event.stopPropagation()); check.addEventListener('change', () => check.checked ? addBatch(element) : removeBatch(keyOf(element))); button.prepend(check); }
    els['ifc-list'].append(button);
  }
  if (!elements.length) els['ifc-list'].textContent = 'No IFC elements match the current filters.';
}
function collectionNames(asset) { return asset.collection_memberships || asset.collections || []; }
function assetMatches(asset) {
  const query = els['asset-query'].value.trim().toLowerCase();
  if (query && ![asset.name, asset.serial].some(value => String(value || '').toLowerCase().includes(query))) return false;
  if (els.location.value && locationKey(asset.current_location) !== els.location.value) return false;
  const collection = els.collection.value; const memberships = collectionNames(asset); if (collection === 'UNKNOWN' && memberships.length) return false;
  if (collection && collection !== 'UNKNOWN' && !memberships.some(item => (typeof item === 'string' ? item : item.id) === collection)) return false;
  const linked = state.mappings.some(mapping => mapping.itemit_item_id === asset.id); const status = els['asset-status'].value;
  return !status || (status === 'CONFIRMED' ? linked : !linked);
}
function renderAssets() {
  const assets = state.assets.filter(assetMatches); const totalPages = Math.max(1, Math.ceil(assets.length / PAGE_SIZE)); state.page = Math.min(state.page, totalPages - 1); const pageAssets = assets.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  els['asset-list'].replaceChildren(); els['asset-count'].textContent = `${assets.length} available`; els.page.textContent = `Page ${state.page + 1} of ${totalPages}`; els.previous.disabled = state.page === 0; els.next.disabled = state.page >= totalPages - 1;
  const assetFilterActive = Boolean(els['asset-query'].value || els.location.value || els.collection.value || els['asset-status'].value); els['clear-asset-filters'].hidden = !assetFilterActive; els['active-filters'].textContent = assetFilterActive ? [els.location.value && `Location: ${els.location.options[els.location.selectedIndex].text}`, els.collection.value && `Collection: ${els.collection.options[els.collection.selectedIndex].text}`, els['asset-status'].value && `State: ${els['asset-status'].value}`].filter(Boolean).join(' · ') : '';
  for (const asset of pageAssets) {
    const linked = state.mappings.find(mapping => mapping.itemit_item_id === asset.id); const reserved = state.batch.find(entry => entry.asset?.id === asset.id && keyOf(entry.element) !== keyOf(state.selectedIfc)); const button = document.createElement('button'); button.type = 'button'; button.className = 'list-row'; button.classList.toggle('selected', asset.id === state.selectedAsset?.id); button.disabled = Boolean(linked || reserved); const label = linked ? `Confirmed · ${linked.model_key}:${linked.ifc_global_id}` : reserved ? 'Assigned in this batch' : 'Not mapped'; const badgeClass = linked ? 'status-confirmed' : reserved ? 'status-assigned' : 'status-unmapped'; button.innerHTML = `<strong>${escape(text(asset.name))}</strong><span>Serial: <code>${escape(text(asset.serial))}</code> · ${escape(text(asset.current_location))}</span><em class="status-badge ${badgeClass}">${escape(label)}</em>`; button.addEventListener('click', () => selectAsset(asset)); els['asset-list'].append(button);
  }
  if (!pageAssets.length) els['asset-list'].textContent = 'No itemit assets match the current filters.';
}
function renderBatch() {
  els['batch-queue'].hidden = state.mode !== 'batch'; els['clear-batch'].hidden = state.mode !== 'batch';
  if (state.mode !== 'batch') return;
  els['batch-queue'].replaceChildren();
  const assigned = state.batch.filter(entry => entry.asset).length;
  const heading = document.createElement('div'); heading.className = 'queue-header'; heading.innerHTML = `<div><p class="queue-heading">Batch queue</p><span>${assigned} of ${state.batch.length} assigned</span></div><p class="queue-instruction">Select a row, choose an itemit asset, then assign it. Nothing is confirmed until you confirm the batch.</p>`; els['batch-queue'].append(heading);
  const list = document.createElement('div'); list.className = 'queue-list';
  if (!state.batch.length) { const empty = document.createElement('p'); empty.className = 'queue-empty'; empty.textContent = 'Select IFC elements from the source list to begin a batch.'; list.append(empty); }
  for (const entry of state.batch) {
    const active = keyOf(entry.element) === keyOf(state.selectedIfc); const globalId = identity(entry.element)?.globalId; const row = document.createElement('article'); row.className = 'queue-row'; row.classList.toggle('active', active);
    const select = document.createElement('button'); select.type = 'button'; select.className = 'queue-select'; select.setAttribute('aria-current', active ? 'true' : 'false'); select.innerHTML = `<span class="queue-element"><strong>${escape(elementName(entry.element))}</strong><span><code>${escape(shortId(globalId))}</code><em>${escape(text(entry.element.ifcType))}</em></span></span><span class="queue-assignment"><strong>${escape(entry.asset ? text(entry.asset.name) : 'No itemit asset assigned')}</strong><span>${escape(entry.asset ? shortId(entry.asset.id) : 'Choose an itemit asset, then assign')}</span></span><em class="status-badge ${entry.asset ? 'status-assigned' : 'status-unmapped'}">${entry.asset ? 'Assigned' : 'Unassigned'}</em>`;
    select.addEventListener('click', () => { state.selectedIfc = entry.element; state.selectedAsset = entry.asset || null; render(); }); row.append(select);
    const details = document.createElement('details'); details.className = 'queue-details'; details.innerHTML = `<summary>Details</summary><dl><div><dt>GlobalId</dt><dd><code>${escape(globalId)}</code></dd></div><div><dt>IFC type</dt><dd>${escape(text(entry.element.ifcType))}</dd></div><div><dt>itemit ID</dt><dd><code>${escape(entry.asset?.id || 'Unassigned')}</code></dd></div></dl>`; row.append(details);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button queue-remove'; remove.textContent = 'Remove'; remove.addEventListener('click', () => removeBatch(keyOf(entry.element))); row.append(remove); list.append(row);
  }
  els['batch-queue'].append(list);
}
function render() {
  const single = state.mode === 'single'; const hasIfc = Boolean(state.selectedIfc); const hasAsset = Boolean(state.selectedAsset); const showPairPreview = single ? hasIfc || hasAsset : hasIfc && hasAsset;
  const lockNotice = document.querySelector('.mapping-lock-notice');
  if (lockNotice) lockNotice.textContent = mappingFor(state.selectedIfc) ? 'Unmap this confirmed relationship before choosing a replacement asset.' : '';
  els['single-review'].classList.toggle('batch-pair-preview', !single); els['single-review'].classList.toggle('single-sided-review', hasIfc !== hasAsset); els['single-review'].hidden = !showPairPreview; els['review-empty'].hidden = !single || hasIfc || hasAsset; els['review-guidance'].hidden = !single || !(hasIfc !== hasAsset); els['review-guidance'].textContent = hasIfc ? 'Now select an itemit asset to complete this pair.' : 'Now select an IFC element to complete this pair.';
  if (showPairPreview) { renderIfcCard(); renderAssetCard(); }
  renderIfcList(); renderAssets(); renderBatch(); renderDisplayName(); refreshConfirm();
}
async function selectIfc(rawElement) {
  const element = resolveMappingIdentity(rawElement, state.indexes);
  if (!element) { message('Building Overview is read-only unless this GlobalId resolves to exactly one room-model element. No mapping was selected.', 'error'); return; }
  state.selectedIfc = element; state.selectedAsset = state.mode === 'batch' ? state.batch.find(entry => keyOf(entry.element) === keyOf(element))?.asset || null : null; state.editingDisplayName = false;
  try {
    const persisted = await getMappingStatus({ modelKey: identity(element).modelKey, globalId: identity(element).globalId });
    if (!mappingFor(element)) state.mappings.push(persisted);
    // A confirmed record remains inspectable. Fetch its real inventory record
    // so the page displays the linked itemit asset rather than only its UUID.
    state.selectedAsset = state.assets.find(asset => asset.id === persisted.itemit_item_id) || await getAsset(persisted.itemit_item_id);
  }
  catch (error) { if (error.status !== 404) { state.mappingsAvailable = false; message(error.message, 'error'); } }
  render();
}
async function selectAsset(summary) {
  try {
    state.selectedAsset = await getAsset(summary.id);
    render();
  } catch (error) { message(error.message, 'error'); }
}
function addBatch(element) { if (!isConfirmed(element) && !state.batch.some(entry => keyOf(entry.element) === keyOf(element))) state.batch.push({ element, asset: null }); render(); }
function removeBatch(key) { state.batch = state.batch.filter(entry => keyOf(entry.element) !== key); if (keyOf(state.selectedIfc) === key) state.selectedAsset = null; render(); }
function assignBatchAsset() {
  const entry = state.batch.find(candidate => keyOf(candidate.element) === keyOf(state.selectedIfc));
  if (!entry || !state.selectedAsset) return;
  const duplicate = state.batch.find(candidate => candidate !== entry && candidate.asset?.id === state.selectedAsset.id);
  if (duplicate) { message(`This itemit asset is already assigned to ${elementName(duplicate.element)} in this batch.`, 'error'); return; }
  entry.asset = state.selectedAsset;
  const next = state.batch.find(candidate => !candidate.asset);
  if (next) { state.selectedIfc = next.element; state.selectedAsset = null; }
  render();
}
async function confirmMappings() {
  await runMappingSubmission(async () => {
    if (state.isSubmitting) return;
    const entries = state.mode === 'batch' ? state.batch.filter(entry => entry.asset && !isConfirmed(entry.element)) : [{ element: state.selectedIfc, asset: state.selectedAsset }];
    if (!entries.length || entries.some(entry => !identity(entry.element) || !entry.asset || isConfirmed(entry.element))) { refreshConfirm(); return; }
    state.isSubmitting = true; refreshConfirm(); const failures = []; let submitted = 0;
    try {
      const result = await submitMappingEntries(entries, async entry => {
        const id = identity(entry.element);
        await createMapping({ model_key: id.modelKey, ifc_global_id: id.globalId, itemit_item_id: entry.asset.id, mapping_status: 'CONFIRMED', mapping_method: 'MANUAL' });
      });
      submitted = result.submitted;
      if (result.error) failures.push(result.error.message);
      if (submitted) {
        try { state.mappings = await getMappings(); state.mappingsAvailable = true; }
        catch (error) { state.mappingsAvailable = false; failures.push(error.message); }
      }
      if (state.mode === 'batch') state.batch = state.batch.filter(entry => !mappingFor(entry.element));
      message(failures.length ? failures.join(' ') : `${submitted} mapping${submitted === 1 ? '' : 's'} confirmed and locked.`, failures.length ? 'error' : 'success');
    } catch (error) {
      message(error.message || 'Unable to confirm mapping.', 'error');
    } finally {
      state.isSubmitting = false;
      render();
    }
  });
}
async function unmapSelectedMapping() {
  await runUnmapping(async () => {
    const mapped = state.selectedIfc && mappingFor(state.selectedIfc);
    if (!mapped || state.isUnmapping) return;
    state.isUnmapping = true; render();
    try {
      await deleteMapping({ modelKey: mapped.model_key, globalId: mapped.ifc_global_id });
      state.mappings = state.mappings.filter(row => row.model_key !== mapped.model_key || row.ifc_global_id !== mapped.ifc_global_id);
      state.selectedAsset = null;
      state.editingDisplayName = false;
      await refreshData({ announce: false });
      message('Mapping removed. Choose an itemit asset to create a new mapping.', 'success');
    } catch (error) {
      message(error.message || 'Unable to unmap this IFC element.', 'error');
    } finally {
      state.isUnmapping = false;
      render();
    }
  });
}
function populateFilters() {
  const currentLocation = els.location.value; const currentCollection = els.collection.value;
  els.location.replaceChildren(new Option('All locations', ''));
  els.collection.replaceChildren(new Option('All collections', ''), new Option('Unknown', 'UNKNOWN'));
  const locations = [...new Map(state.assets.map(asset => [locationKey(asset.current_location), asset.current_location]).filter(([key]) => key !== 'other')).entries()].sort(([left], [right]) => left.localeCompare(right)); for (const [key, location] of locations) els.location.add(new Option(location, key));
  for (const collection of state.collections) els.collection.add(new Option(collection.name, collection.id));
  if ([...els.location.options].some(option => option.value === currentLocation)) els.location.value = currentLocation;
  if ([...els.collection.options].some(option => option.value === currentCollection)) els.collection.value = currentCollection;
  locationPicker.refresh(); collectionPicker.refresh();
}
async function refreshData({ announce = true } = {}) {
  const selectedAssetId = state.selectedAsset?.id;
  els['refresh-data'].disabled = true; els['refresh-data'].setAttribute('aria-busy', 'true');
  if (announce) message('Refreshing inventory, collections, and mappings…');
  try {
  const [assetResult, collectionResult, mappingResult] = await Promise.allSettled([getAssets(), getCollections(), getMappings()]);
  if (assetResult.status === 'rejected') {
    state.apiAvailable = false;
    message(assetResult.reason.message || 'Unable to retrieve itemit assets.', 'error');
    render();
  } else {
    const assets = assetResult.value;
    state.assets = assets;
    state.apiAvailable = true;
    if (selectedAssetId) state.selectedAsset = assets.find(asset => asset.id === selectedAssetId) || null;
    state.batch.forEach(entry => { if (entry.asset) entry.asset = assets.find(asset => asset.id === entry.asset.id) || entry.asset; });
    const unavailable = [];
    if (collectionResult.status === 'fulfilled') state.collections = collectionResult.value;
    else { state.collections = []; unavailable.push(`collections: ${collectionResult.reason.message}`); }
    if (mappingResult.status === 'fulfilled') { state.mappings = mappingResult.value; state.mappingsAvailable = true; }
    else { state.mappingsAvailable = false; unavailable.push(`mappings: ${mappingResult.reason.message}`); }
    populateFilters(); render();
    if (unavailable.length) message(`Loaded ${assets.length} itemit assets. Some mapping data is unavailable (${unavailable.join('; ')}).`, 'error');
    else if (announce) message(`Updated ${assets.length} itemit assets, ${state.collections.length} collections, and ${state.mappings.length} mappings.`, 'success');
  }
  } finally {
    els['refresh-data'].disabled = false; els['refresh-data'].setAttribute('aria-busy', 'false');
  }
}
async function start() {
  try { const { manifest, indexes } = await loadIfcIndexes(); state.indexes = indexes; const mappingModels = manifest.models.filter(model => model.key !== 'building'); for (const model of mappingModels) els.model.add(new Option(model.name || model.key, model.key)); els['index-state'].textContent = `${mappingModels.length} mapping models · Indexed ${formatIndexedAt(manifest.generatedAt)}`; }
  catch (error) { els['index-state'].textContent = 'IFC index required'; message(error.message, 'error'); return; }
  await refreshData({ announce: false });
  render();
}
for (const control of [els['ifc-query'], els['ifc-scope'], els['ifc-status']]) control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', () => { state.ifcPage = 0; els['clear-ifc-filters'].hidden = !(els['ifc-query'].value || els['ifc-scope'].value !== 'likely' || els['ifc-status'].value); render(); });
for (const control of [els['asset-query'], els.location, els.collection, els['asset-status']]) control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', () => { state.page = 0; if (control === els.location) state.locationFilterSource = 'user'; render(); });
els.model.addEventListener('change', () => { state.selectedIfc = null; state.selectedAsset = null; state.ifcPage = 0; state.batch = state.batch.filter(entry => identity(entry.element)?.modelKey === els.model.value); const suggested = modelLocation[els.model.value]; if (state.locationFilterSource === 'auto' && suggested && [...els.location.options].some(option => option.value === suggested)) els.location.value = suggested; locationPicker.refresh(); render(); });
els['single-mode'].addEventListener('click', () => { state.mode = 'single'; els['single-mode'].classList.add('active'); els['batch-mode'].classList.remove('active'); els['mode-label'].textContent = 'Single'; render(); });
els['batch-mode'].addEventListener('click', () => { state.mode = 'batch'; els['batch-mode'].classList.add('active'); els['single-mode'].classList.remove('active'); els['mode-label'].textContent = 'Batch'; render(); });
els['clear-batch'].addEventListener('click', () => { state.batch = []; state.selectedAsset = null; render(); });
els['select-visible'].addEventListener('change', () => { const eligible = elementsForCurrentModel().filter(eligibleIfc).slice(state.ifcPage * PAGE_SIZE, (state.ifcPage + 1) * PAGE_SIZE).filter(element => !isConfirmed(element)); if (els['select-visible'].checked) eligible.forEach(addBatch); else { const visible = new Set(eligible.map(keyOf)); state.batch = state.batch.filter(entry => !visible.has(keyOf(entry.element))); render(); } });
els['assign'].addEventListener('click', assignBatchAsset);
for (const [toggle, panel] of [[els['ifc-filter-toggle'], els['ifc-filter-panel']], [els['asset-filter-toggle'], els['asset-filter-panel']]]) toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); });
els['ifc-previous'].addEventListener('click', () => { state.ifcPage -= 1; renderIfcList(); }); els['ifc-next'].addEventListener('click', () => { state.ifcPage += 1; renderIfcList(); });
els['previous'].addEventListener('click', () => { state.page -= 1; renderAssets(); }); els.next.addEventListener('click', () => { state.page += 1; renderAssets(); });
els['clear-ifc-filters'].addEventListener('click', () => { els['ifc-query'].value = ''; els['ifc-scope'].value = 'likely'; els['ifc-status'].value = ''; scopePicker.refresh(); ifcStatusPicker.refresh(); state.ifcPage = 0; els['clear-ifc-filters'].hidden = true; render(); });
els['clear-asset-filters'].addEventListener('click', () => { els['asset-query'].value = ''; els.location.value = ''; els.collection.value = ''; els['asset-status'].value = ''; locationPicker.refresh(); collectionPicker.refresh(); assetStatusPicker.refresh(); state.locationFilterSource = 'user'; state.page = 0; render(); });
els['refresh-data'].addEventListener('click', () => { void refreshData(); });
els.confirm.addEventListener('click', confirmMappings);
els.unmap.addEventListener('click', unmapSelectedMapping);
document.getElementById('edit-display-name').addEventListener('click', () => { state.editingDisplayName = true; render(); document.getElementById('display-name-input').focus(); });
document.getElementById('cancel-display-name').addEventListener('click', () => { state.editingDisplayName = false; render(); });
document.getElementById('display-name-editor').addEventListener('submit', async event => { event.preventDefault(); const mapped = state.selectedIfc && mappingFor(state.selectedIfc); const input = document.getElementById('display-name-input'); const value = input.value.trim(); if (!mapped || !value) { message('Display name cannot be empty.', 'error'); return; } const save = document.getElementById('save-display-name'); save.disabled = true; save.textContent = 'Saving…'; try { const updated = await updateDisplayName({ model_key: mapped.model_key, ifc_global_id: mapped.ifc_global_id, display_name: value }); const index = state.mappings.findIndex(row => row.model_key === updated.model_key && row.ifc_global_id === updated.ifc_global_id); if (index >= 0) state.mappings[index] = updated; state.editingDisplayName = false; message('Display name saved.', 'success'); } catch (error) { message(error.message, 'error'); } finally { save.textContent = 'Save'; render(); } });
void start();
