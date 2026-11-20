const Module = require('module');

class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(e) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        // 监听器错误不阻塞
      }
    }
  }
}

class TreeItem {
  constructor(label) {
    this.label = label;
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(v) {
    this.value += v;
  }
}

class MockWorkspaceConfiguration {
  constructor(data, onUpdate) {
    this._data = { ...data };
    this._onUpdate = onUpdate || (() => {});
  }
  get(key, defaultValue) {
    return key in this._data ? this._data[key] : defaultValue;
  }
  inspect(key) {
    return {
      key,
      defaultValue: undefined,
      globalValue: key in this._data ? this._data[key] : undefined,
      workspaceValue: undefined,
      workspaceFolderValue: undefined,
    };
  }
  update(key, value, target) {
    this._data[key] = value;
    this._onUpdate(key, value, target);
    return Promise.resolve();
  }
  set(key, value) {
    this._data[key] = value;
  }
}

const state = {
  config: {},
  updateLog: [],
  commands: {},
  executed: [],
};

function installVscodeMock(initialConfig = {}, options = {}) {
  state.config = { ...initialConfig };
  state.updateLog = [];
  state.executed = [];
  state.commands = options.commands || {};

  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1, Intermediate: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      createWebviewPanel: () => {
        const listeners = {};
        const listeners2 = {};
        return {
          webview: {
            html: '',
            cspSource: 'vscode-resource:',
            postMessage: () => Promise.resolve(),
            onDidReceiveMessage: (cb) => {
              const handler = (msg) => cb(msg);
              Object.defineProperty(listeners, 'msg', { value: handler, enumerable: false });
              return { dispose: () => {} };
            },
          },
          onDidReceiveMessage: () => ({ dispose: () => {} }),
          onDidDispose: (cb) => {
            Object.defineProperty(listeners2, 'd', { value: cb, enumerable: false });
            return { dispose: () => {} };
          },
          reveal: () => {},
          dispose: () => {},
        };
      },
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: '',
        show: () => {},
        hide: () => {},
        dispose: () => {},
      }),
      createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        show: () => {},
        clear: () => {},
        dispose: () => {},
      }),
      createTreeView: () => ({
        selection: [],
        dispose: () => {},
      }),
      registerTreeDataProvider: () => ({ dispose: () => {} }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => undefined,
      withProgress: async (_, fn) => fn({ report: () => {} }),
    },
    workspace: {
      getConfiguration: (section) => {
        const prefix = section ? `${section}.` : '';
        return new MockWorkspaceConfiguration(
          Object.fromEntries(
            Object.entries(state.config)
              .filter(([k]) => k.startsWith(prefix))
              .map(([k]) => [k.slice(prefix.length), state.config[k]])
          ),
          (key, value) => {
            state.updateLog.push({ section, key, value });
          }
        );
      },
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
    commands: {
      registerCommand: (cmd, handler) => {
        state.commands[cmd] = handler;
        return { dispose: () => {} };
      },
      executeCommand: async (cmd, ...args) => {
        state.executed.push({ cmd, args });
        if (state.commands[cmd]) {
          return state.commands[cmd](...args);
        }
        return undefined;
      },
    },
    env: {
      openExternal: async () => true,
      language: options.language || 'zh-cn',
      clipboard: { writeText: async () => {} },
    },
    Uri: {
      parse: (s) => ({ toString: () => s, fsPath: s }),
      file: (s) => ({ fsPath: s, toString: () => s }),
    },
    ViewColumn: { Active: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    Disposable: class {
      constructor(fn) {
        this._fn = fn;
      }
      dispose() {
        if (this._fn) this._fn();
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return vscode;
    }
    return originalLoad.apply(this, arguments);
  };
}

function getState() {
  return state;
}

function clearVscodeMock() {
  state.config = {};
  state.updateLog = [];
  state.commands = {};
  state.executed = [];
}

module.exports = {
  installVscodeMock,
  getState,
  clearVscodeMock,
};
