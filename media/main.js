/* menuconfig webview — vanilla JS, no build step required. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const el = {
    search: document.getElementById('search'),
    showHidden: document.getElementById('show-hidden'),
    status: document.getElementById('status'),
    info: document.getElementById('info'),
    tree: document.getElementById('tree'),
    detail: document.getElementById('detail'),
    save: document.getElementById('btn-save'),
    header: document.getElementById('btn-header'),
    reload: document.getElementById('btn-reload'),
  };

  const state = {
    snapshot: null,
    tree: [],
    symbols: {},
    expanded: new Set(),
    selected: null,
    filter: '',
    showHidden: false,
    dirty: false,
    help: null,
    helpPending: false,
  };

  const searchIndex = [];

  // ------------------------------------------------------------------
  // persisted UI state
  // ------------------------------------------------------------------

  function restoreState() {
    const saved = vscode.getState();
    if (!saved || typeof saved !== 'object') {
      return;
    }
    if (Array.isArray(saved.expanded)) {
      state.expanded = new Set(saved.expanded);
    }
    if (typeof saved.selected === 'string') {
      state.selected = saved.selected;
    }
    if (typeof saved.showHidden === 'boolean') {
      state.showHidden = saved.showHidden;
      el.showHidden.checked = saved.showHidden;
    }
  }

  function persistState() {
    vscode.setState({
      expanded: Array.from(state.expanded),
      selected: state.selected,
      showHidden: state.showHidden,
    });
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function isVisible(node) {
    return state.showHidden || node.v > 0;
  }

  function symbolOf(node) {
    if (!node || node.k !== 'sym' || !node.s) {
      return null;
    }
    return state.symbols[node.s] || null;
  }

  function displayLabel(node) {
    if (node.t) {
      return node.t;
    }
    return node.s || '';
  }

  function typeLabel(sym) {
    const type = sym.type || 'unknown';
    if (sym.choice && (type === 'bool' || type === 'tristate')) {
      return type + ' (choice)';
    }
    return type;
  }

  // ------------------------------------------------------------------
  // tree rendering
  // ------------------------------------------------------------------

  function renderTree() {
    el.tree.textContent = '';
    if (!state.snapshot) {
      el.tree.appendChild(emptyHint('Loading…'));
      return;
    }
    if (state.filter) {
      renderSearchResults();
      return;
    }
    const fragment = document.createDocumentFragment();
    const stack = [];
    for (let i = state.tree.length - 1; i >= 0; i -= 1) {
      stack.push({ node: state.tree[i], depth: 0 });
    }
    while (stack.length) {
      const item = stack.pop();
      const node = item.node;
      if (!isVisible(node)) {
        continue;
      }
      fragment.appendChild(buildRow(node, item.depth));
      if (node.c && state.expanded.has(node.id)) {
        for (let i = node.c.length - 1; i >= 0; i -= 1) {
          stack.push({ node: node.c[i], depth: item.depth + 1 });
        }
      }
    }
    el.tree.appendChild(fragment);
  }

  function buildRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'row k-' + node.k + (node.v === 0 ? ' hidden-node' : '');
    if (node.s && node.s === state.selected) {
      row.classList.add('selected');
    }
    row.style.paddingLeft = 6 + depth * 14 + 'px';
    row.dataset.id = String(node.id);

    const twisty = document.createElement('span');
    twisty.className = 'twisty' + (node.c ? '' : ' leaf');
    twisty.textContent = node.c ? (state.expanded.has(node.id) ? '▾' : '▸') : '•';
    if (node.c) {
      twisty.addEventListener('click', function (event) {
        event.stopPropagation();
        toggleNode(node.id);
      });
    }
    row.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = displayLabel(node);
    label.title = displayLabel(node);
    row.appendChild(label);

    if (node.k === 'sym' && node.s) {
      const name = document.createElement('span');
      name.className = 'sym';
      name.textContent = node.s;
      row.appendChild(name);

      const ctl = document.createElement('span');
      ctl.className = 'ctl';
      ctl.appendChild(buildInlineControl(node));
      ctl.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      row.appendChild(ctl);

      row.addEventListener('click', function () {
        selectSymbol(node.s);
      });
    } else if (node.c) {
      row.addEventListener('click', function () {
        toggleNode(node.id);
      });
    }

    return row;
  }

  function buildInlineControl(node) {
    const sym = symbolOf(node);
    if (!sym) {
      return document.createTextNode('');
    }
    if (sym.type === 'bool' || sym.type === 'tristate') {
      return segmented(sym, sym.type === 'tristate');
    }
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = sym.value;
    badge.title = 'Value: ' + sym.value + ' (edit in the detail panel)';
    return badge;
  }

  function segmented(sym, tristate) {
    const wrap = document.createElement('span');
    wrap.className = 'seg';
    const options = tristate
      ? [['n', 0], ['m', 1], ['y', 2]]
      : [['n', 0], ['y', 2]];
    for (const pair of options) {
      const text = pair[0];
      const value = pair[1];
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      const allowed = (sym.assignable || []).indexOf(value) >= 0;
      const current = sym.value === text;
      if (current) {
        button.className = 'on';
      }
      if (!allowed) {
        button.disabled = true;
        button.title = text + ' is not assignable here';
      } else if (!current) {
        button.title = 'Set ' + text;
      }
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        if (!current) {
          applyValue(sym, text);
        }
      });
      wrap.appendChild(button);
    }
    return wrap;
  }

  function emptyHint(text) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.style.padding = '10px';
    div.textContent = text;
    return div;
  }

  function toggleNode(id) {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
    } else {
      state.expanded.add(id);
    }
    persistState();
    renderTree();
  }

  // ------------------------------------------------------------------
  // search
  // ------------------------------------------------------------------

  function walkForSearch(nodes, trail) {
    for (const node of nodes) {
      const path = node.t ? trail.concat([node.t]) : trail;
      if (node.k === 'sym' && node.s) {
        const sym = state.symbols[node.s];
        searchIndex.push({
          name: node.s,
          prompt: node.t || '',
          type: sym ? sym.type : '',
          value: sym ? sym.value : '',
          visibility: node.v,
          path: trail,
          node: node,
        });
      }
      if (node.c) {
        walkForSearch(node.c, path);
      }
    }
  }

  function rebuildSearchIndex() {
    searchIndex.length = 0;
    walkForSearch(state.tree, []);
  }

  function renderSearchResults() {
    const query = state.filter.toLowerCase();
    const matches = [];
    for (const entry of searchIndex) {
      if (!state.showHidden && entry.visibility === 0) {
        continue;
      }
      if (
        entry.name.toLowerCase().indexOf(query) >= 0 ||
        entry.prompt.toLowerCase().indexOf(query) >= 0
      ) {
        matches.push(entry);
        if (matches.length >= 400) {
          break;
        }
      }
    }

    el.tree.textContent = '';
    if (matches.length === 0) {
      el.tree.appendChild(emptyHint('No symbol matches "' + state.filter + '".'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of matches) {
      const row = buildRow(entry.node, 0);
      row.classList.add('search-result');
      if (entry.path.length) {
        const pathLabel = document.createElement('span');
        pathLabel.className = 'path';
        pathLabel.textContent = entry.path.join(' / ');
        row.appendChild(pathLabel);
      }
      fragment.appendChild(row);
    }
    el.tree.appendChild(fragment);
  }

  // ------------------------------------------------------------------
  // detail panel
  // ------------------------------------------------------------------

  function selectSymbol(name) {
    state.selected = name;
    state.help = null;
    state.helpPending = false;
    persistState();
    const sym = state.symbols[name];
    if (sym && sym.hasHelp) {
      state.helpPending = true;
    }
    renderTree();
    renderDetail();
    if (sym && sym.hasHelp) {
      requestHelp(name);
    }
  }

  function requestHelp(name) {
    vscode.postMessage({ type: 'help', sym: name });
  }

  function renderDetail() {
    el.detail.textContent = '';
    const name = state.selected;
    const sym = name ? state.symbols[name] : null;
    if (!sym) {
      el.detail.appendChild(emptyHint('Select a symbol to edit it.'));
      return;
    }

    const title = document.createElement('h2');
    title.textContent = sym.prompt || name;
    el.detail.appendChild(title);

    const nameLine = document.createElement('div');
    nameLine.className = 'name';
    nameLine.textContent = 'CONFIG_' + name;
    el.detail.appendChild(nameLine);

    const dl = document.createElement('dl');
    addRow(dl, 'Type', typeLabel(sym));
    addRow(dl, 'Value', sym.value);
    addRow(dl, 'Visibility', visibilityText(sym));
    addRow(dl, 'Assignable', (sym.assignable || []).map(triText).join(', ') || 'none');
    if (sym.choice) {
      addRow(dl, 'Choice', sym.selected ? 'selected' : 'not selected');
    }
    el.detail.appendChild(dl);

    const editor = document.createElement('div');
    editor.className = 'editor';
    el.detail.appendChild(editor);

    if (sym.type === 'bool' || sym.type === 'tristate') {
      editor.appendChild(segmented(sym, sym.type === 'tristate'));
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = sym.value;
      input.spellcheck = false;
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          applyValue(sym, input.value);
        }
      });
      editor.appendChild(input);

      const apply = document.createElement('button');
      apply.className = 'btn';
      apply.textContent = 'Apply';
      apply.addEventListener('click', function () {
        applyValue(sym, input.value);
      });
      editor.appendChild(apply);
    }

    const reset = document.createElement('button');
    reset.className = 'btn';
    reset.textContent = 'Reset';
    reset.title = 'Unset the user value and fall back to the default';
    reset.addEventListener('click', function () {
      vscode.postMessage({ type: 'unset', sym: name });
    });
    editor.appendChild(reset);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = valueHint(sym);
    el.detail.appendChild(hint);

    if (sym.loc) {
      const locTitle = document.createElement('div');
      locTitle.className = 'section-title';
      locTitle.textContent = 'Defined at';
      el.detail.appendChild(locTitle);

      const link = document.createElement('a');
      link.className = 'link';
      link.textContent = sym.loc.file + ':' + sym.loc.line;
      link.addEventListener('click', function () {
        vscode.postMessage({ type: 'open', file: sym.loc.file, line: sym.loc.line });
      });
      el.detail.appendChild(link);
    }

    const helpTitle = document.createElement('div');
    helpTitle.className = 'section-title';
    helpTitle.textContent = 'Help';
    el.detail.appendChild(helpTitle);

    if (!sym.hasHelp) {
      el.detail.appendChild(emptyHint('No help text.'));
    } else if (state.help === null) {
      el.detail.appendChild(emptyHint(state.helpPending ? 'Loading…' : 'Open this symbol to load help.'));
    } else {
      const pre = document.createElement('pre');
      pre.className = 'help';
      pre.textContent = state.help;
      el.detail.appendChild(pre);
    }
  }

  function addRow(dl, key, value) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function triText(value) {
    if (value === 0) {
      return 'n';
    }
    if (value === 1) {
      return 'm';
    }
    if (value === 2) {
      return 'y';
    }
    return String(value);
  }

  function visibilityText(sym) {
    if (!sym.visibility) {
      return 'hidden (0)';
    }
    if (sym.visibility === 1) {
      return 'visible as m';
    }
    return 'visible (2)';
  }

  function valueHint(sym) {
    if (sym.type === 'int' || sym.type === 'hex') {
      return sym.type === 'hex'
        ? 'Hexadecimal, e.g. 0x1A.'
        : 'Decimal integer. Out-of-range values are ignored by Kconfig.';
    }
    if (sym.type === 'string') {
      return 'String value, quotes are added when writing .config.';
    }
    if (sym.type === 'bool') {
      return 'Boolean: y or n.';
    }
    if (sym.type === 'tristate') {
      return 'Tristate: y, m or n. m requires module support.';
    }
    return '';
  }

  // ------------------------------------------------------------------
  // actions
  // ------------------------------------------------------------------

  function applyValue(sym, value) {
    setStatus('Applying ' + (sym.name || '') + '…');
    vscode.postMessage({ type: 'set', sym: sym.name, value: value });
  }

  // ------------------------------------------------------------------
  // messages from the extension
  // ------------------------------------------------------------------

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'snapshot':
        applySnapshot(message.data);
        break;
      case 'delta':
        applyDelta(message.data);
        break;
      case 'help':
        if (message.sym === state.selected) {
          state.help = message.text || '';
          state.helpPending = false;
          renderDetail();
        }
        break;
      case 'status':
        setStatus(message.text || '', message.kind);
        break;
      case 'dirty':
        state.dirty = Boolean(message.dirty);
        updateInfo();
        break;
      case 'warn':
        setStatus(message.message || '', 'error');
        break;
      case 'error':
        setStatus(message.message || 'error', 'error');
        break;
      default:
        break;
    }
  });

  function applySnapshot(data) {
    state.snapshot = data;
    state.tree = data.tree || [];
    state.symbols = {};
    const incoming = data.symbols || {};
    for (const name of Object.keys(incoming)) {
      state.symbols[name] = Object.assign({ name: name }, incoming[name]);
    }
    rebuildSearchIndex();
    renderTree();
    renderDetail();
    updateInfo();
  }

  function applyDelta(data) {
    if (data.tree) {
      state.tree = data.tree;
    }
    const changed = data.changed || {};
    for (const name of Object.keys(changed)) {
      const update = changed[name];
      const existing = state.symbols[name] || {};
      state.symbols[name] = Object.assign({}, existing, update, { name: name });
    }
    if (data.tree) {
      rebuildSearchIndex();
    }
    renderTree();
    renderDetail();
    updateInfo();
    setStatus('', 'ok');
  }

  function updateInfo() {
    if (!state.snapshot) {
      el.info.textContent = '';
      return;
    }
    const parts = [
      state.snapshot.mainmenu || '(no mainmenu)',
      Object.keys(state.symbols).length + ' symbols',
      state.dirty ? 'unsaved changes' : 'saved',
    ];
    if (state.snapshot.warnings && state.snapshot.warnings.length) {
      parts.push(state.snapshot.warnings.length + ' warning(s)');
    }
    el.info.textContent = parts.join('  ·  ');
  }

  // ------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------

  let searchTimer = null;
  el.search.addEventListener('input', function () {
    const value = el.search.value.trim();
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(function () {
      state.filter = value;
      renderTree();
    }, 120);
  });

  el.showHidden.addEventListener('change', function () {
    state.showHidden = el.showHidden.checked;
    persistState();
    renderTree();
  });

  el.save.addEventListener('click', function () {
    vscode.postMessage({ type: 'save' });
  });

  el.header.addEventListener('click', function () {
    vscode.postMessage({ type: 'header' });
  });

  el.reload.addEventListener('click', function () {
    vscode.postMessage({ type: 'reload' });
  });

  restoreState();
  renderDetail();
  vscode.postMessage({ type: 'ready' });
})();
