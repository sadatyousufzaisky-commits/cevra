import { planTask } from './continuum/task-plan.cjs';

const outcomes = { pending: 'Waiting', running: 'Running', passed: 'Passed', failed: 'Failed',
  blocked: 'Blocked', cancelled: 'Canceled' };

export function createTaskPanel({ api, errorText, runTask, jump }) {
  const byId = id => document.getElementById(id);
  const panel = byId('task-panel');
  const select = byId('task-choice');
  const refresh = byId('task-refresh');
  const run = byId('task-run');
  const status = byId('task-status');
  const workspace = byId('task-workspace');
  const preview = byId('task-preview');
  const results = byId('task-results');
  const steps = byId('task-steps');
  const rows = new Map();
  let project;
  let catalog;
  let plan = [];
  let busy;
  let request = 0;

  function sync() {
    select.disabled = !catalog || !select.options[1];
    run.disabled = busy || !plan.length;
    refresh.disabled = !project;
  }

  function showPlan() {
    plan = catalog && select.value ? planTask(catalog, select.value) : [];
    const commands = new Map(catalog?.scripts.map(script => [script.id, script.command]));
    preview.replaceChildren(...plan.map(step => {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = step.id + ' · npm --ignore-scripts run ' + step.profile;
      const command = document.createElement('code');
      command.textContent = commands.get(step.profile);
      row.append(title, command);
      if (step.after.length) {
        const dependency = document.createElement('span');
        dependency.textContent = 'After ' + step.after.join(', ') +
          (step.continueOnFailure ? ' · Continue if a dependency fails' : '');
        row.append(dependency);
      }
      return row;
    }));
    sync();
  }

  function updateChoices(previous = '') {
    select.replaceChildren(new Option('Choose a task', ''));
    for (const [label, prefix, entries] of [
      ['Dependency graphs', 'dag:', catalog?.tasks], ['Package scripts', 'npm:', catalog?.scripts],
    ]) {
      if (!entries?.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const { id } of entries) group.append(new Option(id, prefix + id));
      select.append(group);
    }
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
    showPlan();
  }

  async function load() {
    if (!project) return;
    const generation = ++request;
    const previous = select.value;
    catalog = undefined;
    workspace.textContent = workspace.title = project.root;
    updateChoices();
    status.textContent = 'Reading package scripts…';
    try {
      const next = await api.taskCatalog(project.id);
      if (generation !== request) return;
      catalog = next;
      status.textContent = catalog.scripts.length ?
        'Review a task before running it. Output appears in Task output.' : 'No supported scripts in the root package.json.';
      if (catalog.omitted) status.textContent += ' Unsupported scripts omitted: ' + catalog.omitted + '.';
      const scope = [project.root, catalog.outputs.length ? 'Revision checks exclude ' + catalog.outputs.join(', ') : ''].filter(Boolean).join(' · ');
      workspace.textContent = workspace.title = scope;
      updateChoices(previous);
    } catch (error) {
      if (generation === request) status.textContent = errorText(error);
    }
  }

  function updateStep(event) {
    const row = rows.get(event.id);
    if (!row) return;
    const name = document.createElement('strong');
    name.textContent = event.id;
    const state = document.createElement('span');
    state.textContent = outcomes[event.outcome];
    const detail = document.createElement('span');
    detail.textContent = [event.reason, event.exitCode == null ? '' : 'Exit ' + event.exitCode,
      event.durationMs ? event.durationMs + ' ms' : ''].filter(Boolean).join(' · ');
    row.dataset.outcome = event.outcome;
    row.replaceChildren(name, state, detail);
    if (event.anchor) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'diagnostic-link';
      const { path, line, column } = event.anchor;
      link.textContent = path + ':' + line + ':' + column;
      link.onclick = () => jump(event.anchor, () => rows.get(event.id) === row);
      row.append(link);
    }
  }

  select.onchange = showPlan;
  refresh.onclick = () => void load();
  run.onclick = () => {
    if (!run.disabled) void runTask(select.value, catalog.revision, plan);
  };

  return {
    reset(next) {
      ++request;
      project = next;
      catalog = undefined;
      updateChoices();
      if (!panel.hidden) void load();
    },
    show(visible) {
      panel.hidden = !visible;
      if (visible) void load();
    },
    setBusy(value) { busy = value; sync(); },
    start(ordered) {
      rows.clear();
      steps.replaceChildren();
      results.hidden = !ordered.length;
      for (const { id } of ordered) {
        const row = document.createElement('li');
        rows.set(id, row);
        steps.append(row);
        updateStep({ id, outcome: 'pending' });
      }
    },
    progress: updateStep,
    blockWaiting(reason) {
      for (const [id, row] of rows) {
        if (row.dataset.outcome === 'pending') updateStep({ id, outcome: 'blocked', reason });
      }
    },
  };
}
