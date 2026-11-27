// Menu editor: keeps the whole menu in memory, renders it as a form, and
// saves the complete document to the server in one request.
(function () {
  'use strict';

  const data = JSON.parse(document.getElementById('editor-data').textContent);
  const limits = data.limits;
  const root = document.getElementById('editor');
  const statusEl = document.getElementById('save-status');
  const saveButton = document.getElementById('save-button');
  let csrfToken = document.querySelector('meta[name="csrf-token"]').content;

  // ---- State ----------------------------------------------------------------

  // Client-only keys identify sections/items across re-renders (for focus).
  let lastKey = 0;
  const newKey = () => String(++lastKey);

  const newItem = (item = {}) => ({
    key: newKey(),
    name: item.name || '',
    description: item.description || '',
    price: item.price || '',
    tags: (item.tags || []).join(', '), // edited as free text, split by the server
    available: item.available !== false,
  });

  const newSection = (section = {}) => ({
    key: newKey(),
    name: section.name || '',
    description: section.description || '',
    items: (section.items || []).map(newItem),
  });

  const menu = {
    id: data.menu.id,
    updatedAt: data.menu.updatedAt,
    title: data.menu.title,
    description: data.menu.description,
    currency: data.menu.currency,
    published: data.menu.published,
    sections: data.menu.sections.map(newSection),
  };

  let revision = 0; // bumped on every edit
  let savedRevision = 0; // revision the server last confirmed
  let saving = false;
  let blocked = false; // set after a conflict; saving needs a reload

  const isDirty = () => revision !== savedRevision;

  function changed() {
    revision++;
    showSaveState();
  }

  // ---- DOM helpers ----------------------------------------------------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name === 'class') el.className = value;
      else if (name === 'dataset') Object.assign(el.dataset, value);
      else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
      else if (value === true) el.setAttribute(name, '');
      else el.setAttribute(name, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function textField(opts) {
    const input = opts.multiline
      ? h('textarea', { rows: opts.rows || 2, maxlength: opts.max, placeholder: opts.placeholder })
      : h('input', { type: 'text', maxlength: opts.max, placeholder: opts.placeholder });
    input.value = opts.value;
    if (opts.focus) input.dataset.focus = opts.focus;
    input.addEventListener('input', () => {
      input.classList.remove('is-invalid');
      opts.onInput(input.value);
      changed();
    });
    return h('label', { class: `field ${opts.className || ''}` },
      h('span', { class: opts.hideLabel ? 'sr-only' : null }, opts.label),
      input);
  }

  function checkboxField(opts) {
    const input = h('input', { type: 'checkbox' });
    input.checked = opts.checked;
    input.addEventListener('change', () => {
      opts.onChange(input.checked);
      changed();
    });
    return h('label', { class: `check ${opts.className || ''}` },
      input,
      h('span', null, h('strong', null, opts.label), opts.hint ? h('small', null, opts.hint) : null));
  }

  function iconButton(label, title, disabled, onClick, focus) {
    return h('button', {
      type: 'button',
      class: 'btn btn-icon',
      title,
      'aria-label': title,
      disabled,
      dataset: { focus },
      onclick: onClick,
    }, label);
  }

  /** Finds a focusable control inside the section/item with the given key. */
  function findControl(key, ...focusIds) {
    const scope = key ? root.querySelector(`[data-key="${key}"]`) : root;
    if (!scope) return null;
    for (const id of focusIds) {
      const el = scope.querySelector(`[data-focus="${id}"]`);
      if (el && !el.disabled) return el;
    }
    return null;
  }

  function focusControl(key, ...focusIds) {
    const el = findControl(key, ...focusIds) || findControl(null, 'add-section');
    if (el) el.focus();
  }

  // ---- Rendering ------------------------------------------------------------

  function render() {
    root.replaceChildren(
      detailsCard(),
      h('div', { class: 'sections-head' },
        h('h2', null, 'Sections'),
        h('p', { class: 'muted small' }, 'Group your dishes, e.g. Starters, Mains, Desserts, Drinks.')),
      ...(menu.sections.length
        ? menu.sections.map(sectionCard)
        : [h('div', { class: 'empty-state' },
          h('p', null, 'This menu has no sections yet. Add one to start listing dishes.'))]),
      h('button', {
        type: 'button',
        class: 'btn btn-add-section',
        dataset: { focus: 'add-section' },
        onclick: addSection,
      }, '+ Add section'));
  }

  function detailsCard() {
    return h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Menu details'),
      textField({
        label: 'Title',
        value: menu.title,
        max: limits.title,
        placeholder: 'e.g. Dinner menu',
        focus: 'menu-title',
        onInput: (v) => { menu.title = v; },
      }),
      textField({
        label: 'Description',
        value: menu.description,
        max: limits.description,
        multiline: true,
        placeholder: 'Optional — a welcome note, opening hours, allergy information…',
        onInput: (v) => { menu.description = v; },
      }),
      h('div', { class: 'field-row' },
        textField({
          label: 'Currency symbol',
          value: menu.currency,
          max: limits.currency,
          placeholder: '$',
          className: 'field-currency',
          onInput: (v) => { menu.currency = v; },
        }),
        checkboxField({
          label: 'Published',
          hint: 'Customers can open this menu by scanning its QR code. Untick to hide it.',
          checked: menu.published,
          onChange: (v) => { menu.published = v; },
        })));
  }

  function sectionCard(section, index) {
    const last = menu.sections.length - 1;
    return h('section', { class: 'card section-card', dataset: { key: section.key } },
      h('div', { class: 'section-head' },
        textField({
          label: `Section ${index + 1} name`,
          value: section.name,
          max: limits.sectionName,
          placeholder: 'Section name, e.g. Starters',
          className: 'field-section-name',
          hideLabel: true,
          focus: 'section-name',
          onInput: (v) => { section.name = v; },
        }),
        h('div', { class: 'row-controls' },
          iconButton('↑', 'Move section up', index === 0,
            () => moveSection(index, -1), 'section-up'),
          iconButton('↓', 'Move section down', index === last,
            () => moveSection(index, 1), 'section-down'),
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-danger-ghost',
            onclick: () => removeSection(index),
          }, 'Delete section'))),
      textField({
        label: 'Section note',
        value: section.description,
        max: limits.sectionDescription,
        placeholder: 'Optional note, e.g. “Served with fresh bread” or “Available until 3pm”',
        className: 'field-section-note',
        hideLabel: true,
        onInput: (v) => { section.description = v; },
      }),
      section.items.length
        ? h('ol', { class: 'item-list' }, section.items.map((item, i) => itemRow(section, item, i)))
        : h('p', { class: 'muted small no-items' }, 'No items in this section yet.'),
      h('button', {
        type: 'button',
        class: 'btn btn-sm',
        dataset: { focus: 'add-item' },
        onclick: () => addItem(section),
      }, '+ Add item'));
  }

  function itemRow(section, item, index) {
    const last = section.items.length - 1;
    const row = h('li', {
      class: `item-row${item.available ? '' : ' is-unavailable'}`,
      dataset: { key: item.key },
    });
    row.append(
      h('div', { class: 'item-grid' },
        textField({
          label: 'Name',
          value: item.name,
          max: limits.itemName,
          placeholder: 'e.g. Margherita pizza',
          className: 'field-item-name',
          focus: 'item-name',
          onInput: (v) => { item.name = v; },
        }),
        textField({
          label: 'Price',
          value: item.price,
          max: limits.price,
          placeholder: '12.50',
          className: 'field-price',
          onInput: (v) => { item.price = v; },
        }),
        textField({
          label: 'Description',
          value: item.description,
          max: limits.itemDescription,
          multiline: true,
          placeholder: 'Optional — ingredients, portion size…',
          className: 'field-item-description',
          onInput: (v) => { item.description = v; },
        }),
        textField({
          label: 'Tags',
          value: item.tags,
          max: limits.tag * limits.tagsPerItem,
          placeholder: 'Optional, comma separated — e.g. Vegan, Gluten-free, Spicy',
          className: 'field-tags',
          onInput: (v) => { item.tags = v; },
        })),
      h('div', { class: 'item-foot' },
        checkboxField({
          label: 'Available',
          hint: 'Untick to show as sold out',
          checked: item.available,
          className: 'check-inline',
          onChange: (v) => {
            item.available = v;
            row.classList.toggle('is-unavailable', !v);
          },
        }),
        h('div', { class: 'row-controls' },
          iconButton('↑', 'Move item up', index === 0,
            () => moveItem(section, index, -1), 'item-up'),
          iconButton('↓', 'Move item down', index === last,
            () => moveItem(section, index, 1), 'item-down'),
          iconButton('✕', 'Delete item', false,
            () => removeItem(section, index), 'item-delete'))));
    return row;
  }

  // ---- Actions --------------------------------------------------------------

  function swap(list, i, j) {
    [list[i], list[j]] = [list[j], list[i]];
  }

  function addSection() {
    const section = newSection();
    menu.sections.push(section);
    changed();
    render();
    focusControl(section.key, 'section-name');
  }

  function moveSection(index, delta) {
    const section = menu.sections[index];
    swap(menu.sections, index, index + delta);
    changed();
    render();
    const [here, other] = delta < 0 ? ['section-up', 'section-down'] : ['section-down', 'section-up'];
    focusControl(section.key, here, other);
  }

  function removeSection(index) {
    const section = menu.sections[index];
    const count = section.items.length;
    if (section.name.trim() || count) {
      const what = count ? ` and its ${count} ${count === 1 ? 'item' : 'items'}` : '';
      const name = section.name.trim() ? `“${section.name.trim()}”` : 'this section';
      if (!window.confirm(`Delete ${name}${what}?`)) return;
    }
    menu.sections.splice(index, 1);
    changed();
    render();
    const next = menu.sections[index] || menu.sections[index - 1];
    focusControl(next && next.key, 'section-name');
  }

  function addItem(section) {
    const item = newItem();
    section.items.push(item);
    changed();
    render();
    focusControl(item.key, 'item-name');
  }

  function moveItem(section, index, delta) {
    const item = section.items[index];
    swap(section.items, index, index + delta);
    changed();
    render();
    const [here, other] = delta < 0 ? ['item-up', 'item-down'] : ['item-down', 'item-up'];
    focusControl(item.key, here, other);
  }

  function removeItem(section, index) {
    const item = section.items[index];
    if (item.name.trim() && !window.confirm(`Delete “${item.name.trim()}”?`)) return;
    section.items.splice(index, 1);
    changed();
    render();
    const next = section.items[index] || section.items[index - 1];
    if (next) focusControl(next.key, 'item-name');
    else focusControl(section.key, 'add-item');
  }

  // ---- Saving ---------------------------------------------------------------

  function setStatus(kind, ...content) {
    statusEl.className = `editor-status${kind ? ` is-${kind}` : ''}`;
    statusEl.replaceChildren(...content);
  }

  function showSaveState() {
    if (saving || blocked) return;
    if (isDirty()) setStatus('dirty', 'Unsaved changes');
    else setStatus('saved', 'All changes saved');
  }

  function firstProblem() {
    if (!menu.title.trim()) return { focus: 'menu-title', message: 'Give the menu a title.' };
    for (const section of menu.sections) {
      if (!section.name.trim()) {
        return { key: section.key, focus: 'section-name', message: 'Every section needs a name.' };
      }
      for (const item of section.items) {
        if (!item.name.trim()) {
          return { key: item.key, focus: 'item-name', message: 'Every item needs a name.' };
        }
      }
    }
    return null;
  }

  function payload() {
    return {
      updatedAt: menu.updatedAt,
      menu: {
        title: menu.title,
        description: menu.description,
        currency: menu.currency,
        published: menu.published,
        sections: menu.sections.map((s) => ({
          name: s.name,
          description: s.description,
          items: s.items.map((i) => ({
            name: i.name,
            description: i.description,
            price: i.price,
            tags: i.tags,
            available: i.available,
          })),
        })),
      },
    };
  }

  function put() {
    return fetch(`/admin/api/menus/${menu.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(payload()),
    });
  }

  /** After signing in again (e.g. in another tab) the CSRF token changes. */
  async function refreshCsrfToken() {
    const res = await fetch('/admin/api/session');
    if (!res.ok) return false;
    csrfToken = (await res.json()).csrfToken;
    return true;
  }

  async function save() {
    if (saving || blocked) return;

    const problem = firstProblem();
    if (problem) {
      const input = findControl(problem.key, problem.focus);
      if (input) {
        input.classList.add('is-invalid');
        input.focus();
        input.scrollIntoView({ block: 'center' });
      }
      setStatus('error', problem.message);
      return;
    }

    saving = true;
    saveButton.disabled = true;
    setStatus('saving', 'Saving…');
    const savingRevision = revision;

    try {
      let res = await put();
      if (res.status === 403 && (await refreshCsrfToken())) res = await put();
      const body = await res.json().catch(() => ({}));
      saving = false;

      if (res.ok) {
        menu.updatedAt = body.menu.updatedAt;
        savedRevision = savingRevision;
        showSaveState();
      } else if (res.status === 409) {
        blocked = true;
        setStatus('error', `${body.error} `,
          h('button', { type: 'button', class: 'link-button', onclick: () => location.reload() },
            'Reload'));
      } else if (res.status === 401) {
        setStatus('error', 'Your session expired. ',
          h('a', { href: '/admin/login?next=/admin', target: '_blank', rel: 'noopener' },
            'Sign in in a new tab'),
          ', then press Save again. Your changes are still here.');
      } else {
        setStatus('error', body.error || 'Could not save. Please try again.');
      }
    } catch {
      saving = false;
      setStatus('error', 'Could not reach the server. Check your connection and try again.');
    } finally {
      saveButton.disabled = blocked;
    }
  }

  saveButton.addEventListener('click', save);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  render();
  showSaveState();
})();
