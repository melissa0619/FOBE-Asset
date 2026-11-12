import './searchable-select.css';

export function makeSearchableSelect(select, { placeholder = 'All collections' } = {}) {
  const shell = document.createElement('div'); shell.className = 'searchable-select';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'searchable-select-trigger';
  const popover = document.createElement('div'); popover.className = 'searchable-select-popover'; popover.hidden = true;
  const query = document.createElement('input'); query.type = 'search'; query.placeholder = 'Find a collection…'; query.setAttribute('aria-label', 'Find a collection');
  const list = document.createElement('div'); list.className = 'searchable-select-list'; list.setAttribute('role', 'listbox');
  popover.append(query, list); select.classList.add('searchable-select-native'); select.after(shell); shell.append(select, trigger, popover);
  const label = option => option?.textContent || placeholder;
  function updateTrigger() { trigger.textContent = label(select.selectedOptions[0]); trigger.setAttribute('aria-expanded', String(!popover.hidden)); }
  function render() {
    const term = query.value.trim().toLowerCase(); list.replaceChildren();
    const options = [...select.options].filter(option => !term || option.text.toLowerCase().includes(term));
    for (const option of options) { const row = document.createElement('button'); row.type = 'button'; row.setAttribute('role', 'option'); row.className = 'searchable-select-option'; row.textContent = option.text; row.setAttribute('aria-selected', String(option.value === select.value)); row.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); close(); }); list.append(row); }
    if (!options.length) list.textContent = 'No collections found.';
  }
  function close() { popover.hidden = true; query.value = ''; updateTrigger(); }
  trigger.addEventListener('click', () => { popover.hidden = !popover.hidden; updateTrigger(); if (!popover.hidden) { render(); query.focus(); } });
  query.addEventListener('input', render); select.addEventListener('change', updateTrigger);
  document.addEventListener('click', event => { if (!shell.contains(event.target)) close(); });
  new MutationObserver(() => { updateTrigger(); if (!popover.hidden) render(); }).observe(select, { childList: true, subtree: true });
  updateTrigger(); return { refresh: updateTrigger };
}
