export function createRecipesPanel({ api, errorText, edit, updateFile, runRecipe }) {
  const byId = id => document.getElementById(id);
  const panel = byId('recipes-panel');
  const select = byId('recipe-choice');
  const status = byId('recipe-status');
  const trust = byId('recipe-trust');
  const preview = byId('recipe-preview');
  const refresh = byId('recipe-refresh');
  const create = byId('recipe-create');
  const open = byId('recipe-edit');
  const upgrade = byId('recipe-upgrade');
  const revoke = byId('recipe-revoke');
  const run = byId('recipe-run');
  let project;
  let catalog;
  let plan;
  let trusted = false;
  let loaded = false;
  let busy = false;
  let editing = false;
  let generation = 0;

  function sync() {
    const locked = busy || editing || !project;
    select.disabled = !catalog?.recipes.length;
    refresh.disabled = editing || !project;
    open.hidden = !loaded || catalog?.missing;
    create.hidden = !catalog?.missing;
    upgrade.hidden = catalog?.schemaVersion !== 1;
    revoke.hidden = !trusted;
    for (const button of [create, open, upgrade, revoke]) button.disabled = locked;
    run.disabled = locked || !plan;
  }

  function showPlan(value) {
    plan = value;
    preview.replaceChildren(...(value?.preview ?? []).map(step => {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = step.id;
      row.append(title);
      for (const detail of step.details) {
        const code = document.createElement('code');
        code.textContent = detail;
        row.append(code);
      }
      return row;
    }));
    sync();
  }

  function hint() {
    if (catalog?.missing) return 'Create a recipe file to start saving workflows for this workspace.';
    if (!catalog?.recipes.length) return 'There are no recipes in this file.';
    if (catalog.schemaVersion === 1) return 'Version 1 recipes can run as single steps. Upgrade to edit them as version 2.';
    return 'Select a recipe to review its steps in execution order.';
  }

  async function review() {
    const request = ++generation;
    const id = select.value;
    showPlan();
    if (!id) { status.textContent = hint(); return; }
    status.textContent = 'Resolving recipe steps…';
    try {
      const value = await api.recipePreview(project.id, id);
      if (request !== generation) return;
      showPlan(value);
      status.textContent = 'Review the steps, then choose Run recipe to confirm.' +
        (catalog.schemaVersion === 1 ? ' Upgrade the file when you are ready to use multiple steps.' : '');
    } catch (error) {
      if (request === generation) status.textContent = errorText(error);
    }
  }

  async function load() {
    if (!project) return;
    const request = ++generation;
    const previous = select.value;
    catalog = undefined;
    loaded = false;
    trusted = false;
    trust.textContent = '';
    showPlan();
    status.textContent = 'Reading workspace recipes…';
    const [recipes, consent] = await Promise.allSettled([api.recipeCatalog(project.id), api.workspaceTrust(project.id)]);
    if (request !== generation) return;
    loaded = true;
    trusted = consent.status === 'fulfilled' && consent.value === true;
    trust.textContent = consent.status === 'rejected' ? 'Workspace trust could not be read.' :
      trusted ? 'Trusted workspace · Recipe confirmation required' : 'Untrusted workspace · Execution requires consent';
    select.replaceChildren(new Option('Choose a recipe', ''));
    if (recipes.status === 'rejected') {
      status.textContent = errorText(recipes.reason);
      sync();
      return;
    }
    catalog = recipes.value;
    for (const { id, name } of catalog.recipes) select.append(new Option(name + ' · ' + id, id));
    if (catalog.recipes.some(recipe => recipe.id === previous)) select.value = previous;
    await review();
  }

  async function change(action) {
    const scope = project;
    editing = true;
    sync();
    try {
      await action(scope.id);
      if (project === scope) await load();
    } catch (error) {
      if (project === scope) status.textContent = errorText(error);
    } finally {
      editing = false;
      sync();
    }
  }

  select.onchange = () => void review();
  refresh.onclick = () => void load();
  create.onclick = () => void change(() => updateFile('create'));
  upgrade.onclick = () => void change(() => updateFile('upgrade', catalog.revision));
  open.onclick = () => void edit().catch(error => { status.textContent = errorText(error); });
  revoke.onclick = () => void change(id => api.revokeTrust(id));
  run.onclick = () => { if (!run.disabled) void runRecipe(plan); };

  return {
    reset(next) {
      ++generation;
      project = next;
      catalog = undefined;
      loaded = trusted = false;
      select.replaceChildren(new Option('Choose a recipe', ''));
      showPlan();
      if (!panel.hidden) void load();
    },
    show(visible) {
      if (visible === !panel.hidden) return;
      panel.hidden = !visible;
      if (visible) void load();
    },
    setBusy(value) { busy = value; sync(); },
  };
}
