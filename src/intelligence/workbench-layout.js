export function createIntelligenceLayout({ api, report }) {
  const workbench = document.getElementById('workbench');
  const dockSpace = document.getElementById('intelligence-dock-space');
  const power = document.getElementById('intelligence-power');
  const dock = document.getElementById('intelligence-dock-open');
  const windowButton = document.getElementById('intelligence-mock-open');
  const attach = document.getElementById('intelligence-attach-selection');
  let mode;
  let frame;
  let enabled = false;
  let busy = true;
  let toggling = false;

  function sendBounds() {
    frame = undefined;
    if (!mode) return;
    if (document.body.inert || document.querySelector('dialog[open]')) {
      api.setIntelligenceBounds(null);
      return;
    }
    const { x, y, width, height } = (mode === 'workspace' ? workbench : dockSpace).getBoundingClientRect();
    api.setIntelligenceBounds({ x, y, width, height });
  }

  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sendBounds);
  }

  const geometry = new ResizeObserver(schedule);
  geometry.observe(workbench);
  geometry.observe(dockSpace);
  window.addEventListener('resize', schedule);
  const modalVisibility = new MutationObserver(schedule);
  modalVisibility.observe(document.body, { attributes: true, attributeFilter: ['inert'] });
  for (const dialog of document.querySelectorAll('dialog')) modalVisibility.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  api.onIntelligenceLayout(next => {
    mode = next;
    workbench.dataset.intelligenceLayout = next ?? '';
    dockSpace.hidden = next !== 'dock';
    for (const section of workbench.children) {
      if (section !== dockSpace) section.inert = next === 'workspace';
    }
    if (!next && (document.activeElement === document.body || workbench.contains(document.activeElement))) dock.focus();
    schedule();
  });

  function setFeatures(features) {
    enabled = features.intelligenceMock === true;
    power.textContent = enabled ? 'AI On' : 'AI Off';
    power.setAttribute('aria-pressed', String(enabled));
    power.setAttribute('aria-label', (enabled ? 'Turn off' : 'Turn on') + ' VOKRI Intelligence');
    dock.hidden = windowButton.hidden = !enabled;
    attach.hidden = features.intelligenceContext !== true;
    sync();
  }

  function sync() {
    power.disabled = busy || toggling;
    dock.disabled = busy || !enabled;
  }

  const openDock = () => api.openIntelligenceMock(undefined, 'dock');
  dock.onclick = () => void openDock().catch(report);
  power.onclick = async () => {
    if (power.disabled) return;
    toggling = true;
    sync();
    try {
      setFeatures(await api.setIntelligenceEnabled(!enabled));
      if (enabled) await openDock();
    } catch (error) { report(error); }
    finally { toggling = false; sync(); }
  };

  return {
    setFeatures,
    setBusy(value) { busy = value; sync(); },
    openDock,
  };
}
