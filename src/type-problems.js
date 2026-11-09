import { problemRow } from './problems-panel.js';

export function createTypeProblems({ getActive, check, apply, jump, report, errorText }) {
  const status = document.getElementById('type-status');
  const heading = document.getElementById('type-heading');
  const list = document.getElementById('type-list');
  const retry = document.getElementById('type-retry');
  let generation = 0;
  let timer;
  let running = false;
  let decorated;

  async function inspect() {
    timer = undefined;
    const tab = getActive();
    if (!tab?.language || running) return;
    const request = generation;
    const version = tab.version;
    const current = () => request === generation && getActive() === tab && tab.version === version;
    running = true;
    try {
      const { enabled, directive, issues, omitted } = await check(tab);
      if (!current()) return;
      decorated = issues.length ? tab : undefined;
      apply(tab, issues);
      const count = issues.length + omitted;
      status.textContent = directive === 'nocheck' ? 'Type checking is disabled by @ts-nocheck.' :
        !enabled ? 'Enable JavaScript type checking with @ts-check or checkJs.' :
        count ? count + (count === 1 ? ' type problem.' : ' type problems.') : 'No type problems.';
      const rows = issues.map(issue => problemRow(tab, issue, location => {
        if (current()) jump(location, { documentId: tab.id, version, isCurrent: current }).catch(report);
      }));
      list.replaceChildren(...rows);
      if (omitted) {
        const note = document.createElement('li');
        note.className = 'problem-note';
        note.textContent = omitted + ' more type problems.';
        list.append(note);
      }
    } catch (error) {
      if (current()) {
        status.textContent = errorText(error);
        retry.hidden = false;
      }
    } finally {
      running = false;
      if (request !== generation && timer === undefined && getActive()?.language) timer = setTimeout(inspect, 0);
    }
  }

  function refresh(delay = 280) {
    const request = ++generation;
    clearTimeout(timer);
    timer = undefined;
    queueMicrotask(() => {
      if (request !== generation) return;
      const tab = getActive();
      if (decorated) apply(decorated, []);
      decorated = undefined;
      list.replaceChildren();
      retry.hidden = true;
      heading.textContent = tab?.language ? 'Type checking · ' + tab.path : 'Type checking';
      status.textContent = tab?.language ? 'Checking types…' : 'Open a JavaScript or TypeScript file to check types.';
      if (tab?.language) timer = setTimeout(inspect, delay);
    });
  }

  retry.onclick = () => refresh(0);
  return { refresh };
}
