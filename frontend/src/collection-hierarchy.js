function membershipIds(asset) {
  return (asset?.collection_memberships || asset?.collections || [])
    .map(value => typeof value === 'string' ? value : value?.id)
    .filter(Boolean);
}

export function createCollectionHierarchy(collections = []) {
  const nodes = new Map();
  for (const collection of collections) {
    if (collection?.id && collection?.name) nodes.set(collection.id, { id: collection.id, name: collection.name, parentId: collection.parent_id || null });
  }
  const children = new Map([...nodes.keys()].map(id => [id, []]));
  for (const node of nodes.values()) if (node.parentId && children.has(node.parentId)) children.get(node.parentId).push(node.id);
  for (const ids of children.values()) ids.sort((left, right) => nodes.get(left).name.localeCompare(nodes.get(right).name));
  const roots = [...nodes.values()].filter(node => !node.parentId || !nodes.has(node.parentId)).map(node => node.id);
  // Bad source data can contain a parent cycle. Surface every such node as a
  // navigable root rather than omitting it or looping while traversing it.
  const rooted = new Set(); const visit = id => { if (rooted.has(id)) return; rooted.add(id); for (const child of children.get(id) || []) visit(child); };
  roots.forEach(visit); for (const id of nodes.keys()) if (!rooted.has(id)) roots.push(id);
  roots.sort((left, right) => nodes.get(left).name.localeCompare(nodes.get(right).name));
  const descendants = id => {
    const result = new Set([id]); const pending = [...(children.get(id) || [])];
    while (pending.length) { const current = pending.pop(); if (result.has(current)) continue; result.add(current); pending.push(...(children.get(current) || [])); }
    return result;
  };
  const path = id => {
    const names = []; const seen = new Set(); let current = nodes.get(id);
    while (current && !seen.has(current.id)) { names.unshift(current.name); seen.add(current.id); current = nodes.get(current.parentId); }
    return names;
  };
  return { nodes, children, roots, descendants, path };
}

export function assetMatchesCollectionNode(asset, hierarchy, nodeId) {
  if (!hierarchy?.nodes.has(nodeId)) return false;
  const allowed = hierarchy.descendants(nodeId);
  return membershipIds(asset).some(id => allowed.has(id));
}

export function assetHasKnownCollection(asset, hierarchy) {
  return membershipIds(asset).some(id => hierarchy?.nodes.has(id));
}
