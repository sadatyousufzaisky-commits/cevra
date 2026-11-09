export function createWorkspaceLayout() {
  const byId = id => document.getElementById(id);
  const workbench = byId('workbench');
  const sidebar = byId('workspace-sidebar');
  const sidebarToggle = byId('toggle-sidebar');
  const studio = byId('studio');
  const dock = byId('run-panel');
  const dockContent = byId('dock-content');
  const dockToggle = byId('toggle-dock');
  const handle = byId('dock-resizer');
  const crumbs = byId('file-breadcrumbs');
  const minDock = 126;
  let drag;

  function setSidebarVisible(visible) {
    const focusWasInside = sidebar.contains(document.activeElement);
    sidebar.hidden = !visible;
    workbench.classList.toggle('sidebar-hidden', !visible);
    sidebarToggle.setAttribute('aria-expanded', String(visible));
    const label = visible ? 'Hide Explorer' : 'Show Explorer';
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.title = label + ' (Ctrl+B)';
    if (!visible && focusWasInside) sidebarToggle.focus();
  }

  const maxDock = () => Math.max(minDock, Math.floor(studio.clientHeight * 0.48));

  function syncHandle() {
    handle.setAttribute('aria-valuemax', String(maxDock()));
    handle.setAttribute('aria-valuenow', String(dock.offsetHeight));
  }

  function setDockExpanded(expanded) {
    const focused = document.activeElement;
    dock.dataset.collapsed = String(!expanded);
    dockContent.hidden = handle.hidden = !expanded;
    dockToggle.setAttribute('aria-expanded', String(expanded));
    const label = expanded ? 'Hide bottom panel' : 'Show bottom panel';
    dockToggle.setAttribute('aria-label', label);
    dockToggle.title = label + ' (Ctrl+J)';
    if (expanded) syncHandle();
    else if (focused === handle || dockContent.contains(focused)) dockToggle.focus();
  }

  function resizeDock(height) {
    const size = Math.round(Math.max(minDock, Math.min(maxDock(), height)));
    dock.style.setProperty('--dock-size', size + 'px');
    syncHandle();
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, y: event.clientY, height: dock.offsetHeight };
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId === drag?.id) resizeDock(drag.height + drag.y - event.clientY);
  });
  handle.addEventListener('lostpointercapture', event => {
    if (event.pointerId === drag?.id) drag = undefined;
  });
  handle.addEventListener('keydown', event => {
    const height = dock.offsetHeight;
    const sizes = { ArrowUp: height + 16, ArrowDown: height - 16, Home: minDock, End: maxDock() };
    if (sizes[event.key] === undefined) return;
    event.preventDefault();
    resizeDock(sizes[event.key]);
  });
  const observer = new ResizeObserver(() => { if (!handle.hidden) syncHandle(); });
  observer.observe(studio);
  observer.observe(dock);

  const toggleSidebar = () => setSidebarVisible(sidebar.hidden);
  const toggleDock = () => setDockExpanded(dockContent.hidden);
  sidebarToggle.onclick = toggleSidebar;
  dockToggle.onclick = toggleDock;

  return {
    toggleSidebar,
    showSidebar: () => setSidebarVisible(true),
    toggleDock,
    expandDock: () => setDockExpanded(true),
    filePath(path) {
      crumbs.hidden = !path;
      crumbs.title = path ?? '';
      crumbs.textContent = path?.split(/[\\/]/).join(' › ') ?? '';
    },
  };
}
