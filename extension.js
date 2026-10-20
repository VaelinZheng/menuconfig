'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const PYTHON_MIN = [3, 8];
const PANEL_VIEW_TYPE = 'menuconfig.panel';

let outputChannel = null;
let currentPanel = null;
let session = null;

function log(message) {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Menuconfig');
  }
  outputChannel.appendLine(typeof message === 'string' ? message : String(message));
}

function showOutput() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Menuconfig');
  }
  outputChannel.show(true);
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

function expandTemplate(value, folderPath) {
  if (!value) {
    return value;
  }
  return String(value).replace(/\$\{workspaceFolder\}/g, folderPath);
}

function resolvePath(value, folderPath, fallback) {
  const expanded = expandTemplate(value, folderPath);
  const chosen = expanded || expandTemplate(fallback, folderPath);
  if (!chosen) {
    return undefined;
  }
  return path.isAbsolute(chosen) ? chosen : path.join(folderPath, chosen);
}

async function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Open a folder containing Kconfig files first.');
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: 'Select the workspace folder to configure' }
  );
  if (!picked) {
    throw new Error('No workspace folder selected.');
  }
  return picked.folder;
}

function readSettings(folder) {
  const cfg = vscode.workspace.getConfiguration('menuconfig');
  const root = folder.uri.fsPath;

  const rawEnv = cfg.get('env') || {};
  const env = {};
  for (const key of Object.keys(rawEnv)) {
    const value = rawEnv[key];
    if (value !== null && value !== undefined) {
      env[key] = String(value);
    }
  }

  const headerPath = resolvePath(
    cfg.get('headerPath'),
    root,
    '${workspaceFolder}/rts_cfg.h'
  );
  const configSetting = cfg.get('configPath');
  const defaultConfigPath = path.join(path.dirname(headerPath), '.config');
  const configPath = configSetting
    ? resolvePath(configSetting, root, '') || defaultConfigPath
    : defaultConfigPath;

  return {
    folder,
    pythonPath: cfg.get('pythonPath') || '',
    searchRoot: resolvePath(cfg.get('searchRoot'), root, '${workspaceFolder}'),
    headerPath,
    configPath,
    kconfigName: cfg.get('kconfigName') || 'Kconfig',
    aggregateName: cfg.get('aggregateName') || 'Kconfig.projbuild',
    aggregateMode: cfg.get('aggregateMode') || 'roots',
    excludeDirs: cfg.get('excludeDirs') || ['.git', 'build', 'out'],
    env,
    includeGuard: cfg.get('includeGuard') !== false,
    saveOldConfig: cfg.get('saveOldConfig') === true,
    ui: cfg.get('ui') || 'kconfiglib',
    kconfiglibUi: cfg.get('kconfiglibUi') || 'auto',
    menuconfigStyle: cfg.get('menuconfigStyle') || 'default',
    generateHeaderAfterUi: cfg.get('generateHeaderAfterUi') !== false,
  };
}

function initArgs(settings) {
  return {
    root: settings.searchRoot,
    header: settings.headerPath,
    config: settings.configPath,
    kconfigName: settings.kconfigName,
    aggregateName: settings.aggregateName,
    mode: settings.aggregateMode,
    excludeDirs: settings.excludeDirs,
    env: settings.env,
  };
}

// ---------------------------------------------------------------------------
// python discovery
// ---------------------------------------------------------------------------

function pythonCandidates(configured) {
  const candidates = [];
  if (configured) {
    candidates.push({ cmd: configured, args: [] });
  }
  if (process.platform === 'win32') {
    candidates.push(
      { cmd: 'python', args: [] },
      { cmd: 'py', args: ['-3'] },
      { cmd: 'python3', args: [] }
    );
  } else {
    candidates.push(
      { cmd: 'python3', args: [] },
      { cmd: 'python', args: [] }
    );
  }
  return candidates;
}

let pythonCache = null;

function findPython(configured) {
  if (pythonCache && pythonCache.configured === configured) {
    return pythonCache.value;
  }
  const probe =
    'import sys;print("%d.%d|%s" % (sys.version_info[0], sys.version_info[1], sys.executable))';
  let found;
  for (const candidate of pythonCandidates(configured)) {
    let result;
    try {
      result = cp.spawnSync(
        candidate.cmd,
        candidate.args.concat(['-c', probe]),
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      );
    } catch (err) {
      continue;
    }
    if (result.status !== 0 || !result.stdout) {
      continue;
    }
    const parts = result.stdout.trim().split('|');
    const version = parts[0].split('.');
    const major = Number(version[0]);
    const minor = Number(version[1]);
    if (major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1])) {
      const exe = parts[1];
      log(`[python] using ${candidate.cmd} ${candidate.args.join(' ')} (${parts[0]})`);
      found = exe
        ? { cmd: exe, args: [], version: parts[0] }
        : { cmd: candidate.cmd, args: candidate.args.slice(), version: parts[0] };
      break;
    }
  }
  pythonCache = { configured, value: found };
  return found;
}

// ---------------------------------------------------------------------------
// worker client (NDJSON over stdio)
// ---------------------------------------------------------------------------

class WorkerClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.disposed = false;
    this.onExit = options.onExit || (() => {});
  }

  get alive() {
    return Boolean(this.child) && !this.disposed && this.child.exitCode === null;
  }

  start() {
    const { python, script, cwd, env } = this.options;
    const child = cp.spawn(python.cmd, python.args.concat(['-u', script]), {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child = child;

    const decoder = new StringDecoder('utf8');
    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          this.handleLine(line);
        }
        index = buffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      log('[worker] ' + String(chunk).replace(/\s+$/, ''));
    });

    child.stdin.on('error', (err) => {
      log('[worker] stdin error: ' + err.message);
    });

    child.on('error', (err) => {
      log('[worker] spawn failed: ' + err.message);
      this.failAll(err);
    });

    child.on('exit', (code, signal) => {
      log(`[worker] exited (code=${code}, signal=${signal})`);
      if (this.disposed) {
        return;
      }
      const err = new Error(`menuconfig worker exited (code=${code})`);
      this.failAll(err);
      this.onExit(err);
    });

    return this;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      log('[worker] invalid JSON: ' + line.slice(0, 200));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = new Error((message.error && message.error.message) || 'worker error');
      error.kind = message.error && message.error.kind;
      pending.reject(error);
    }
  }

  failAll(err) {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  request(op, args, timeoutMs) {
    if (!this.alive) {
      return Promise.reject(new Error('menuconfig worker is not running'));
    }
    const id = this.nextId++;
    const timeout = timeoutMs || 60000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`menuconfig worker timed out after ${timeout} ms on '${op}'`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(JSON.stringify({ id, op, args: args || {} }) + '\n', 'utf8');
    });
  }

  dispose() {
    this.disposed = true;
    const child = this.child;
    if (!child) {
      return;
    }
    try {
      child.stdin.write(JSON.stringify({ id: 0, op: 'shutdown', args: {} }) + '\n');
      child.stdin.end();
    } catch (err) {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (err) {
        // ignore
      }
    }, 2000);
    if (timer.unref) {
      timer.unref();
    }
  }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

function disposeSession() {
  if (session && session.client) {
    session.client.dispose();
  }
  session = null;
}

async function resolveTarget() {
  const folder = await pickWorkspaceFolder();
  const settings = readSettings(folder);
  const python = findPython(settings.pythonPath);
  if (!python) {
    const pick = await vscode.window.showErrorMessage(
      'menuconfig: Python 3.8 or newer was not found. Install Python or set "menuconfig.pythonPath".',
      'Open Settings'
    );
    if (pick === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'menuconfig.pythonPath');
    }
    throw new Error('Python 3.8+ not found.');
  }

  const extensionRoot = path.resolve(__dirname);
  const workerScript = path.join(extensionRoot, 'python', 'kconfig_worker.py');
  const uiScript = path.join(extensionRoot, 'python', 'kconfig_ui.py');
  if (!fs.existsSync(workerScript)) {
    throw new Error(`Worker script not found: ${workerScript}`);
  }
  if (!fs.existsSync(uiScript)) {
    throw new Error(`UI launcher not found: ${uiScript}`);
  }

  return { folder, settings, python, extensionRoot, workerScript, uiScript };
}

function buildEnv(target, extra) {
  return Object.assign({}, process.env, extra || {}, {
    PYTHONPATH: path.join(target.extensionRoot, 'python', 'vendor'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    srctree: target.settings.searchRoot.replace(/\\/g, '/'),
  });
}

async function getSession() {
  if (session && session.client.alive) {
    return session;
  }
  disposeSession();

  const target = await resolveTarget();
  const env = buildEnv(target, target.settings.env);

  const client = new WorkerClient({
    python: target.python,
    script: target.workerScript,
    cwd: target.settings.searchRoot,
    env,
    onExit: (err) => {
      if (currentPanel) {
        currentPanel.postMessage({ type: 'error', message: err.message });
      }
      session = null;
    },
  });
  client.start();

  session = Object.assign({}, target, { client, snapshot: null });
  log(`[session] root=${target.settings.searchRoot}`);
  return session;
}

async function ensureSnapshot(force) {
  const active = await getSession();
  if (active.snapshot && !force) {
    return active;
  }
  try {
    active.snapshot = await active.client.request('init', initArgs(active.settings), 300000);
  } catch (err) {
    active.snapshot = null;
    throw err;
  }
  return active;
}

// ---------------------------------------------------------------------------
// webview panel
// ---------------------------------------------------------------------------

class MenuconfigPanel {
  static createOrShow() {
    if (currentPanel) {
      currentPanel.panel.reveal(vscode.ViewColumn.Active);
      return currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Menuconfig',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(vscode.Uri.file(path.resolve(__dirname)), 'media')],
        retainContextWhenHidden: false,
      }
    );
    currentPanel = new MenuconfigPanel(panel);
    return currentPanel;
  }

  constructor(panel) {
    this.panel = panel;
    this.disposables = [];
    this.dirty = false;
    this.panel.webview.html = this.html(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (message) => this.onMessage(message),
      null,
      this.disposables
    );
    this.panel.onDidDispose(
      () => {
        currentPanel = null;
        this.disposables.forEach((d) => d.dispose());
      },
      null,
      this.disposables
    );
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const mediaRoot = vscode.Uri.file(path.resolve(__dirname, 'media'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${styleUri}" />
<title>Menuconfig</title>
</head>
<body>
<div id="app">
  <header id="toolbar">
    <div class="brand">Menuconfig</div>
    <input id="search" type="search" placeholder="Search symbols…" autocomplete="off" />
    <label class="chk"><input id="show-hidden" type="checkbox" /> show hidden</label>
    <span id="status" class="status"></span>
    <div class="spacer"></div>
    <button id="btn-save" class="btn" title="Write .config">Save .config</button>
    <button id="btn-header" class="btn primary" title="Write the C header">Generate header</button>
    <button id="btn-reload" class="btn" title="Re-scan Kconfig files">Reload</button>
  </header>
  <main id="main">
    <section id="tree-pane"><div id="tree"></div></section>
    <aside id="detail"><div class="empty">Select a symbol to edit it.</div></aside>
  </main>
  <footer id="footer"><span id="info"></span></footer>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  postMessage(message) {
    if (this.panel) {
      this.panel.webview.postMessage(message);
    }
  }

  async onMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    try {
      switch (message.type) {
        case 'ready':
          await this.sendSnapshot(false);
          break;
        case 'set':
          await this.applyDelta(await this.requireSession((s) => s.client.request('set', { sym: message.sym, value: message.value })));
          break;
        case 'unset':
          await this.applyDelta(await this.requireSession((s) => s.client.request('unset', { sym: message.sym })));
          break;
        case 'help':
          await this.sendHelp(message.sym);
          break;
        case 'save':
          await this.saveConfig();
          break;
        case 'header':
          await this.generateHeader();
          break;
        case 'reload':
          await this.sendSnapshot(true);
          break;
        case 'open':
          await this.openLocation(message.file, message.line);
          break;
        default:
          log('[panel] unknown message: ' + message.type);
      }
    } catch (err) {
      log('[panel] ' + (err && err.stack ? err.stack : err));
      this.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
  }

  async requireSession(action) {
    const active = await ensureSnapshot(false);
    return action(active);
  }

  async sendSnapshot(force) {
    this.postMessage({ type: 'status', text: 'Loading Kconfig…' });
    const active = await ensureSnapshot(force);
    const snapshot = active.snapshot;
    this.panel.title = 'Menuconfig: ' + (snapshot.mainmenu || active.folder.name);
    this.postMessage({ type: 'snapshot', data: snapshot });
    this.postMessage({ type: 'status', text: '', kind: 'ok' });
    this.postMessage({ type: 'dirty', dirty: false });
    this.dirty = false;
    if (snapshot.warnings && snapshot.warnings.length > 0) {
      this.postMessage({ type: 'warn', message: `${snapshot.warnings.length} Kconfig warning(s)` });
    }
  }

  async applyDelta(promise) {
    const result = await promise;
    this.postMessage({ type: 'delta', data: result });
    this.postMessage({ type: 'dirty', dirty: true });
    this.dirty = true;
    if (result.warnings && result.warnings.length > 0) {
      this.postMessage({ type: 'warn', message: result.warnings[result.warnings.length - 1] });
    }
    return result;
  }

  async sendHelp(symbol) {
    const result = await this.requireSession((s) => s.client.request('help', { sym: symbol }));
    this.postMessage({ type: 'help', sym: symbol, text: result.help });
  }

  async saveConfig() {
    const active = await ensureSnapshot(false);
    const result = await active.client.request(
      'save',
      { path: active.settings.configPath, saveOld: active.settings.saveOldConfig }
    );
    this.postMessage({ type: 'status', text: result.message, kind: 'ok' });
    this.postMessage({ type: 'dirty', dirty: false });
    this.dirty = false;
    vscode.window.setStatusBarMessage('menuconfig: ' + result.message, 4000);
    return result;
  }

  async generateHeader() {
    const active = await ensureSnapshot(false);
    const result = await active.client.request(
      'header',
      { path: active.settings.headerPath, includeGuard: active.settings.includeGuard }
    );
    this.postMessage({ type: 'status', text: result.message, kind: 'ok' });
    vscode.window.setStatusBarMessage('menuconfig: ' + result.message, 4000);
    return result;
  }

  async openLocation(file, line) {
    const active = await ensureSnapshot(false);
    let target = file;
    if (!path.isAbsolute(target)) {
      target = path.join(active.settings.searchRoot, target);
    }
    if (!fs.existsSync(target)) {
      vscode.window.showWarningMessage(`menuconfig: file not found: ${target}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

// ---------------------------------------------------------------------------
// Kconfiglib native UI (ncurses menuconfig / Tk guiconfig) in a terminal
// ---------------------------------------------------------------------------

let uiTerminal = null;

function uiArgs(settings, uiScript) {
  const ui = settings.kconfiglibUi === 'menuconfig'
    ? 'curses'
    : settings.kconfiglibUi === 'guiconfig'
      ? 'tk'
      : settings.kconfiglibUi;
  const args = [
    '-u',
    uiScript,
    '--root', settings.searchRoot,
    '--header', settings.headerPath,
    '--config', settings.configPath,
    '--kconfig-name', settings.kconfigName,
    '--aggregate-name', settings.aggregateName,
    '--aggregate-mode', settings.aggregateMode,
    '--ui', ui,
  ];
  for (const dir of settings.excludeDirs) {
    args.push('--exclude-dir', dir);
  }
  if (!settings.includeGuard) {
    args.push('--no-guard');
  }
  if (!settings.generateHeaderAfterUi) {
    args.push('--no-header');
  }
  return args;
}

async function launchKconfiglibUi(givenTarget) {
  const target = givenTarget || (await resolveTarget());
  const settings = target.settings;

  if (currentPanel && currentPanel.dirty) {
    const choice = await vscode.window.showWarningMessage(
      'menuconfig: the panel has unsaved changes. The terminal UI starts from .config on disk.',
      'Open Anyway',
      'Cancel'
    );
    if (choice !== 'Open Anyway') {
      return undefined;
    }
  }

  const env = buildEnv(target, settings.env);
  env.MENUCONFIG_STYLE = settings.menuconfigStyle;
  env.KCONFIG_CONFIG = settings.configPath;

  const options = {
    name: 'Menuconfig',
    cwd: settings.searchRoot,
    env,
    shellPath: target.python.cmd,
    shellArgs: target.python.args.concat(uiArgs(settings, target.uiScript)),
    iconPath: new vscode.ThemeIcon('gear'),
  };

  if (uiTerminal) {
    uiTerminal.dispose();
    uiTerminal = null;
  }

  const terminal = vscode.window.createTerminal(options);
  uiTerminal = terminal;
  terminal.show(false);

  const subscription = vscode.window.onDidCloseTerminal(async (closed) => {
    if (closed !== terminal) {
      return;
    }
    subscription.dispose();
    if (uiTerminal === terminal) {
      uiTerminal = null;
    }
    const code = closed.exitStatus ? closed.exitStatus.code : undefined;
    if (code === 0) {
      vscode.window.setStatusBarMessage('menuconfig: configuration finished', 5000);
    } else if (typeof code === 'number') {
      log(`[ui] exited with code ${code}`);
      vscode.window.showWarningMessage(
        `menuconfig: the configuration UI exited with code ${code}. See the terminal output.`
      );
    }

    if (currentPanel) {
      if (currentPanel.dirty) {
        vscode.window.showInformationMessage(
          'menuconfig: .config changed in the terminal while the panel has unsaved changes. Use Reload in the panel to pick it up.'
        );
      } else {
        try {
          await currentPanel.sendSnapshot(true);
        } catch (err) {
          log('[ui] refresh after terminal failed: ' + err.message);
        }
      }
    }
  });

  return terminal;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function commandShowCollected() {
  const active = await ensureSnapshot(false);
  const snapshot = active.snapshot;
  const lines = [
    'Menuconfig session',
    '  root       : ' + active.settings.searchRoot,
    '  header     : ' + active.settings.headerPath,
    '  .config    : ' + active.settings.configPath,
    '  aggregate  : ' + snapshot.aggregate,
    '  mode       : ' + snapshot.mode,
    '  kconfiglib : ' + snapshot.version,
    '',
    `Collected ${snapshot.collected.length} Kconfig file(s), aggregated ${snapshot.aggregatedFrom.length}:`,
  ];
  for (const file of snapshot.aggregatedFrom) {
    lines.push('  ' + file);
  }
  if (snapshot.warnings.length > 0) {
    lines.push('', `Warnings (${snapshot.warnings.length}):`);
    snapshot.warnings.forEach((w) => lines.push('  ' + w));
  }
  log(lines.join('\n'));
  showOutput();
  return lines.join('\n');
}

function guardCommand(fn) {
  return async function guardedCommand() {
    try {
      return await fn.apply(null, arguments);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log('[command] ' + (err && err.stack ? err.stack : message));
      vscode.window.showErrorMessage('menuconfig: ' + message);
      return undefined;
    }
  };
}

async function commandOpen() {
  const target = await resolveTarget();
  if (target.settings.ui === 'webview') {
    return MenuconfigPanel.createOrShow();
  }
  return launchKconfiglibUi(target);
}

async function commandOpenWebview() {
  return MenuconfigPanel.createOrShow();
}

async function commandOpenTerminalUi() {
  return launchKconfiglibUi();
}

async function commandSave() {
  const panel = MenuconfigPanel.createOrShow();
  return panel.saveConfig();
}

async function commandHeader() {
  if (currentPanel) {
    return currentPanel.generateHeader();
  }
  const active = await ensureSnapshot(false);
  const result = await active.client.request(
    'header',
    { path: active.settings.headerPath, includeGuard: active.settings.includeGuard }
  );
  vscode.window.showInformationMessage('menuconfig: ' + result.message);
  log('menuconfig: ' + result.message);
  return result;
}

async function commandApplyAndGenerate() {
  const active = await ensureSnapshot(false);
  const saved = await active.client.request(
    'save',
    { path: active.settings.configPath, saveOld: active.settings.saveOldConfig }
  );
  const header = await active.client.request(
    'header',
    { path: active.settings.headerPath, includeGuard: active.settings.includeGuard }
  );
  if (currentPanel) {
    currentPanel.postMessage({ type: 'status', text: header.message, kind: 'ok' });
    currentPanel.postMessage({ type: 'dirty', dirty: false });
    currentPanel.dirty = false;
  }
  vscode.window.showInformationMessage(`menuconfig: ${saved.message} / ${header.message}`);
  return header;
}

async function commandReload() {
  disposeSession();
  if (currentPanel) {
    await currentPanel.sendSnapshot(true);
  } else {
    await ensureSnapshot(true);
  }
  vscode.window.showInformationMessage('menuconfig: Kconfig files re-scanned.');
}

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

const STATUS_BAR_ID = 'menuconfig.status';

let statusBarItem = null;

function statusBarEnabled() {
  const cfg = vscode.workspace.getConfiguration('menuconfig');
  return cfg.get('showStatusBar') !== false;
}

function updateStatusBar() {
  if (!statusBarItem) {
    return;
  }
  const hasFolder = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
  if (!hasFolder || !statusBarEnabled()) {
    statusBarItem.hide();
    return;
  }
  statusBarItem.show();
}

function createStatusBarItem() {
  // The explicit id lets users hide the entry from the status bar context menu.
  const item = vscode.window.createStatusBarItem(STATUS_BAR_ID, vscode.StatusBarAlignment.Left, 100);
  item.name = 'Menuconfig';
  item.text = '$(settings-gear) menuconfig';
  item.tooltip = 'Open the Kconfig configuration UI (menuconfig)';
  item.command = 'menuconfig.open';
  statusBarItem = item;
  updateStatusBar();
  return item;
}

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Menuconfig');

  context.subscriptions.push(
    outputChannel,
    createStatusBarItem(),
    vscode.commands.registerCommand('menuconfig.open', guardCommand(commandOpen)),
    vscode.commands.registerCommand('menuconfig.openTerminalUi', guardCommand(commandOpenTerminalUi)),
    vscode.commands.registerCommand('menuconfig.openWebview', guardCommand(commandOpenWebview)),
    vscode.commands.registerCommand('menuconfig.saveConfig', guardCommand(commandSave)),
    vscode.commands.registerCommand('menuconfig.generateHeader', guardCommand(commandHeader)),
    vscode.commands.registerCommand('menuconfig.applyAndGenerate', guardCommand(commandApplyAndGenerate)),
    vscode.commands.registerCommand('menuconfig.reload', guardCommand(commandReload)),
    vscode.commands.registerCommand('menuconfig.showCollected', guardCommand(commandShowCollected)),
    vscode.commands.registerCommand('menuconfig.showLog', showOutput),
    vscode.workspace.onDidChangeWorkspaceFolders(updateStatusBar),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('menuconfig')) {
        pythonCache = null;
        disposeSession();
        updateStatusBar();
      }
    })
  );

  log('menuconfig extension activated');
}

function deactivate() {
  if (uiTerminal) {
    uiTerminal.dispose();
    uiTerminal = null;
  }
  disposeSession();
}

module.exports = { activate, deactivate };
