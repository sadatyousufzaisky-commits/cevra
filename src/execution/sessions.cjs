const { maxOutput } = require('./process-host.cjs');

function createExecutionSessions(publish) {
  let active;

  function matches(workspaceId, runId, sessionId) {
    return active && active.workspaceId === workspaceId && active.runId === runId && active.sessionId === sessionId;
  }

  function requestStop(session) {
    if (session.stopping) return;
    session.stopping = true;
    session.controller?.stop();
  }

  async function start(workspaceId, runId, sessionId, launch) {
    if (active) throw new Error('A program is already running.');
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid execution request.');
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const session = { workspaceId, runId, sessionId, finished, tail: '', cursor: 0, truncated: false, stopping: false };
    active = session;

    function accept(event) {
      if (active !== session) return;
      if (event.type === 'output') {
        if (event.truncated) session.tail = '';
        if (event.truncated || session.tail.length + event.text.length > maxOutput) session.truncated = true;
        session.tail = (session.tail + event.text).slice(-maxOutput);
        session.cursor += event.text.length;
      } else if (event.type === 'exit') {
        active = undefined;
        finish();
        const stopped = Boolean(session.stopping || event.stopped);
        publish({
          ...event, stopped, location: stopped ? null : event.location,
          workspaceId, runId, sessionId,
          output: { text: session.tail, truncated: session.truncated },
        });
      }
    }

    try {
      session.controller = await launch(accept, () => session.stopping);
      if (active === session && session.stopping) session.controller?.stop();
    } catch (error) {
      if (active !== session) return;
      if (session.stopping) {
        accept({ type: 'exit', code: null, elapsed: 0 });
      } else {
        active = undefined;
        finish();
        throw error;
      }
    }
  }

  return {
    get busy() { return Boolean(active); },
    start,
    output(workspaceId, runId, sessionId, cursor) {
      if (!matches(workspaceId, runId, sessionId) ||
          !Number.isSafeInteger(cursor) || cursor < 0 || cursor > active.cursor) return null;
      const earliest = active.cursor - active.tail.length;
      const reset = cursor < earliest;
      return {
        text: reset ? active.tail : active.tail.slice(cursor - earliest),
        cursor: active.cursor, truncated: active.truncated, reset,
      };
    },
    stop(workspaceId, runId, sessionId) {
      if (!matches(workspaceId, runId, sessionId)) return false;
      requestStop(active);
      return true;
    },
    cancel() {
      const session = active;
      if (session) requestStop(session);
      return session?.finished;
    },
  };
}

module.exports = { createExecutionSessions };
