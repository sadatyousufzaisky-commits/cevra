const panes = ['output', 'problems', 'references', 'terminal', 'flightpath', 'tasks', 'recipes', 'failure', 'changes'];
const defaults = Object.freeze({
  explorer: true, explorerWidth: 240, inspector: false, dockOpen: false,
  dockSize: null, floating: false, pane: 'output', pinned: Object.freeze([]),
});

function workbenchLayout(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults, pinned: [] };
  const size = (key, min, max) => Number.isInteger(value[key]) && value[key] >= min && value[key] <= max ? value[key] : defaults[key];
  return {
    explorer: value.explorer !== false,
    explorerWidth: size('explorerWidth', 160, 400),
    inspector: value.inspector === true,
    dockOpen: value.dockOpen === true,
    dockSize: size('dockSize', 126, 800),
    floating: value.floating === true,
    pane: panes.includes(value.pane) ? value.pane : 'output',
    pinned: Array.isArray(value.pinned) ? panes.filter(pane => pane !== 'output' && value.pinned.includes(pane)) : [],
  };
}

module.exports = { workbenchLayout };
