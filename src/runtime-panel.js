import { typeScriptProfile } from './runtime-kind.cjs';

export function createRuntimePanel({ api, errorText }) {
  const byId = id => document.getElementById(id);
  const panel = byId('runtime-controls');
  const typescript = byId('runtime-typescript');
  const python = byId('runtime-python');
  const choice = byId('python-profile');
  const refresh = byId('python-refresh');
  const browse = byId('python-browse');
  const status = byId('python-status');
  let project;
  let kind;
  let busy = false;
  let pending = false;
  let profiles;
  let selection = '';
  let message = '';

  function render() {
    typescript.hidden = kind !== 'typescript';
    python.hidden = kind !== 'python';
    panel.hidden = !project || (typescript.hidden && python.hidden);
    choice.disabled = busy || pending || !profiles?.length;
    refresh.disabled = browse.disabled = busy || pending;
    const selected = profiles?.find(profile => profile.id === selection);
    status.textContent = message || (pending ? 'Looking for Python interpreters…' : selected ? selected.file :
      profiles?.length ? 'Choose an interpreter before running this file.' : 'No Python interpreter found. Choose a Python 3 executable.');
    status.title = status.textContent;
  }

  function setProfiles(next, preferred) {
    profiles = next;
    choice.replaceChildren(new Option('Choose an interpreter', ''));
    for (const profile of profiles) choice.append(new Option(profile.label + ' · ' + profile.file, profile.id));
    selection = profiles.some(profile => profile.id === preferred) ? preferred : '';
    choice.value = selection;
  }

  async function update(pick = false) {
    if (!project || pending || busy) return;
    const scope = project;
    pending = true;
    message = '';
    render();
    try {
      if (pick) {
        const result = await api.choosePython(scope.id);
        if (result && project === scope) setProfiles(result.profiles, result.selected);
      } else {
        const result = await api.pythonProfiles(scope.id);
        if (project === scope) setProfiles(result, selection);
      }
    } catch (error) {
      if (project === scope) message = errorText(error);
    } finally {
      if (project === scope) {
        pending = false;
        render();
      }
    }
  }

  choice.onchange = () => {
    selection = choice.value;
    message = '';
    render();
  };
  refresh.onclick = () => void update();
  browse.onclick = () => void update(true);

  return {
    sync(next, language, activeRun) {
      if (next !== project) {
        project = next;
        profiles = undefined;
        selection = message = '';
        pending = false;
        choice.replaceChildren(new Option('Choose an interpreter', ''));
      }
      kind = language;
      busy = activeRun;
      render();
      if (kind === 'python' && !profiles && !message) void update();
    },
    profile(language) { return language === 'typescript' ? typeScriptProfile : language === 'python' && !pending ? selection : undefined; },
    focusPython() { (choice.disabled ? browse : choice).focus(); },
  };
}
