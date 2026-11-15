import { workbenchLayout } from './workbench-layout.cjs';

export function createWorkspaceLayout({ persist, reveal, report }) {
  const byId = id => document.getElementById(id);
  const workbench = byId('workbench');
  const sidebar = byId('workspace-sidebar');
  const sidebarToggle = byId('toggle-sidebar');
  const inspector = byId('workspace-inspector');
  const inspectorToggle = byId('toggle-inspector');
  const dock = byId('run-panel');
  const dockContent = byId('dock-content');
  const dockToggle = byId('toggle-dock');
  const dockRail = byId('rail-dock');
  const float = byId('float-dock');
  const pin = byId('pin-panel');
  const dockSeparator = byId('dock-resizer');
  const explorerSeparator = byId('explorer-resizer');
  const pathbar = byId('editor-pathbar');
  const crumbs = byId('file-breadcrumbs');
  const views = [...dock.querySelectorAll('.dock-view')];
  const minDock = 126;
  const minExplorer = 160;
  let state = workbenchLayout();
  let timer;
  let dirty = false;
  let pending;
  let lastPath;
  let lastProject;

  function flush() {
    clearTimeout(timer);
    if (!dirty) return pending;
    dirty = false;
    pending = persist(state).catch(report);
    return pending;
  }

  function changed() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 180);
  }

  function control(button, expanded, label, key) {
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', label);
    button.title = key ? `${label} (${key})` : label;
  }

  function sidebarVisible(visible) {
    const focused = document.activeElement;
    sidebar.hidden = explorerSeparator.hidden = !visible;
    workbench.classList.toggle('sidebar-hidden', !visible);
    control(sidebarToggle, visible, visible ? 'Hide Explorer' : 'Show Explorer', 'Ctrl+B');
    if (!visible && (focused === explorerSeparator || sidebar.contains(focused))) sidebarToggle.focus();
  }

  function inspectorVisible(visible) {
    inspector.hidden = !visible;
    control(inspectorToggle, visible, visible ? 'Hide workspace details' : 'Show workspace details');
    if (!visible && inspector.contains(document.activeElement)) inspectorToggle.focus();
  }

  function dockExpanded(expanded) {
    const focused = document.activeElement;
    dock.dataset.collapsed = String(!expanded);
    dockContent.hidden = dockSeparator.hidden = !expanded;
    control(dockToggle, expanded, expanded ? 'Hide bottom panel' : 'Show bottom panel', 'Ctrl+J');
    dockRail.setAttribute('aria-expanded', String(expanded));
    if (!expanded && (focused === dockSeparator || dockContent.contains(focused))) dockToggle.focus();
  }

  function setOpen(open) {
    if (state.dockOpen === open) return;
    state = { ...state, dockOpen: open };
    dockExpanded(open);
    changed();
  }

  function floating() {
    dock.dataset.floating = String(state.floating);
    float.setAttribute('aria-pressed', String(state.floating));
    float.title = state.floating ? 'Dock bottom panel' : 'Float bottom panel';
    float.setAttribute('aria-label', float.title);
  }

  function syncPins() {
    const current = dock.dataset.pane;
    pin.disabled = current === 'output';
    const pinned = state.pinned.includes(current);
    pin.title = pinned ? 'Unpin current view' : 'Pin current view';
    pin.setAttribute('aria-label', pin.title);
    pin.setAttribute('aria-pressed', String(pinned));
    for (const view of views) view.dataset.pinned = String(state.pinned.includes(view.dataset.view));
    const strip = views[0].parentElement;
    const ordered = [views[0], ...views.filter(view => view.dataset.pinned === 'true'),
      ...views.slice(1).filter(view => view.dataset.pinned === 'false')];
    if (ordered.some((view, index) => view !== strip.children[index])) {
      const focus = strip.contains(document.activeElement) ? document.activeElement : null;
      strip.append(...ordered);
      focus?.focus({ preventScroll: true });
    }
  }

  const maxDock = () => Math.max(minDock, Math.floor(workbench.clientHeight * (state.floating ? 0.64 : 0.48)));
  const maxExplorer = () => Math.max(minExplorer, Math.min(400, Math.floor(workbench.clientWidth * 0.42)));
  const clamp = (n, min, max) => Math.round(Math.max(min, Math.min(max, n)));

  function renderSizes() {
    workbench.style.setProperty('--explorer-width', clamp(state.explorerWidth, minExplorer, maxExplorer()) + 'px');
    if (state.dockSize === null) dock.style.removeProperty('--dock-size');
    else dock.style.setProperty('--dock-size', clamp(state.dockSize, minDock, maxDock()) + 'px');
    if (!explorerSeparator.hidden) {
      explorerSeparator.setAttribute('aria-valuemax', String(maxExplorer()));
      explorerSeparator.setAttribute('aria-valuenow', String(sidebar.offsetWidth));
    }
    if (!dockSeparator.hidden) {
      dockSeparator.setAttribute('aria-valuemax', String(maxDock()));
      dockSeparator.setAttribute('aria-valuenow', String(dock.offsetHeight));
    }
  }

  function splitter(element, { property, measure, coordinate, direction, less, more, min, max }) {
    let drag;
    function resize(size) {
      state = { ...state, [property]: clamp(size, min, max()) };
      renderSizes();
    }
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      element.focus();
      element.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, coordinate: event[coordinate], size: measure() };
    });
    element.addEventListener('pointermove', event => {
      if (event.pointerId === drag?.id) resize(drag.size + direction * (event[coordinate] - drag.coordinate));
    });
    element.addEventListener('lostpointercapture', event => {
      if (event.pointerId !== drag?.id) return;
      drag = undefined;
      changed();
    });
    element.addEventListener('keydown', event => {
      const sizes = { [less]: measure() - 16, [more]: measure() + 16, Home: min, End: max() };
      if (!Object.hasOwn(sizes, event.key)) return;
      event.preventDefault();
      resize(sizes[event.key]);
      changed();
    });
  }

  splitter(explorerSeparator, { property: 'explorerWidth', measure: () => sidebar.offsetWidth, coordinate: 'clientX',
    direction: 1, less: 'ArrowLeft', more: 'ArrowRight', min: minExplorer, max: maxExplorer });
  splitter(dockSeparator, { property: 'dockSize', measure: () => dock.offsetHeight, coordinate: 'clientY',
    direction: -1, less: 'ArrowDown', more: 'ArrowUp', min: minDock, max: maxDock });
  const observer = new ResizeObserver(renderSizes);
  observer.observe(workbench);
  observer.observe(dock);

  function setSidebar(visible) {
    if (state.explorer === visible) return;
    state = { ...state, explorer: visible };
    sidebarVisible(visible);
    renderSizes();
    changed();
  }

  function setInspector(visible) {
    state = { ...state, inspector: visible };
    inspectorVisible(visible);
    changed();
  }

  const toggleSidebar = () => setSidebar(!state.explorer);
  const toggleDock = () => setOpen(!state.dockOpen);
  const toggleInspector = () => setInspector(!state.inspector);
  const toggleFloating = () => {
    state = { ...state, floating: !state.floating };
    floating();
    setOpen(true);
    renderSizes();
    changed();
  };
  const pinView = () => {
    if (pin.disabled) return;
    const view = dock.dataset.pane;
    state = { ...state, pinned: state.pinned.includes(view) ? state.pinned.filter(item => item !== view) : [...state.pinned, view] };
    syncPins();
    changed();
  };
  sidebarToggle.onclick = toggleSidebar;
  dockToggle.onclick = dockRail.onclick = toggleDock;
  inspectorToggle.onclick = toggleInspector;
  inspector.addEventListener('keydown', event => {
    if (event.key === 'Escape') setInspector(false);
  });
  byId('close-inspector').onclick = () => setInspector(false);
  float.onclick = toggleFloating;
  pin.onclick = pinView;

  function applyState() {
    sidebarVisible(state.explorer);
    inspectorVisible(state.inspector);
    dockExpanded(state.dockOpen);
    floating();
    syncPins();
    renderSizes();
  }

  return {
    toggleSidebar, toggleDock, toggleInspector, toggleFloating, pinView, flush,
    showSidebar: () => setSidebar(true),
    reset() { state = workbenchLayout(); applyState(); changed(); },
    restore(saved) { state = workbenchLayout(saved); applyState(); },
    get pane() { return state.pane; },
    get dockOpen() { return state.dockOpen; },
    view(name, { open, remember }) {
      dock.dataset.pane = name;
      if (open) setOpen(true);
      if (remember && name !== state.pane) {
        state = { ...state, pane: name };
        changed();
      }
      syncPins();
    },
    filePath(project, file) {
      if (project === lastProject && file === lastPath) return;
      lastProject = project;
      lastPath = file;
      pathbar.hidden = !project;
      crumbs.replaceChildren();
      if (!project) return;
      const delimiter = project.caseInsensitivePaths ? '\\' : '/';
      const parts = file ? file.split(project.caseInsensitivePaths ? /[\\/]/ : '/') : [];
      const folder = (name, path) => {
        const button = document.createElement('button');
        button.textContent = name;
        button.title = path || project.root;
        button.onclick = () => reveal(path).catch(report);
        crumbs.append(button);
      };
      folder(project.name, '');
      parts.forEach((part, index) => {
        const separator = document.createElement('span');
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '›';
        crumbs.append(separator);
        if (index < parts.length - 1) folder(part, parts.slice(0, index + 1).join(delimiter));
        else {
          const name = document.createElement('span');
          name.textContent = part;
          name.title = file;
          name.setAttribute('aria-current', 'page');
          crumbs.append(name);
        }
      });
      crumbs.scrollLeft = crumbs.scrollWidth;
    },
  };
}
