function startRecipe(plan, refresh, execute, publish, isSessionStopping) {
  const started = performance.now();
  let stopped = false;
  let active;
  const isStopping = () => stopped || isSessionStopping();

  function runStep(step) {
    const current = { controller: undefined };
    active = current;
    let anchor;
    let reason;
    return new Promise((resolve, reject) => {
      function emit(event) {
        if (event.type === 'output') publish(event);
        else if (event.type === 'task-progress' && event.outcome === 'failed') {
          anchor ??= event.anchor;
          reason ??= event.reason;
        } else if (event.type === 'exit') {
          const failure = event.failures?.find(item => item.anchor) ?? event.failures?.[0];
          const location = event.location ?? anchor ?? failure?.anchor;
          resolve({ ...event, location, summary: event.summary ?? failure?.message, error: event.error ?? reason });
        }
      }
      Promise.resolve(execute(step, emit, isStopping)).then(controller => {
        current.controller = controller;
        if (active === current && isStopping()) controller?.stop();
      }, reject);
    }).finally(() => { active = undefined; });
  }

  async function run() {
    let failure;
    let evidence;
    let canceled = false;
    for (const [index, { id, kind }] of plan.steps.entries()) {
      if (isStopping() || canceled || failure) {
        publish({ type: 'task-progress', id, outcome: 'blocked',
          reason: isStopping() || canceled ? 'Run canceled' : 'An earlier step failed' });
        continue;
      }
      let result;
      try {
        const current = index === 0 ? plan : await refresh();
        if (isStopping()) {
          publish({ type: 'task-progress', id, outcome: 'blocked', reason: 'Run canceled' });
          continue;
        }
        publish({ type: 'task-progress', id, outcome: 'running' });
        publish({ type: 'output', text: '\n[Recipe · ' + id + ']\n' });
        result = await runStep(current.steps[index]);
      } catch (error) {
        result = { code: null, error: error.message };
      }
      evidence = result.evidence ?? evidence;
      canceled = Boolean(result.stopped || isStopping());
      if (!canceled && kind === 'test' && result.code === 0 && !(result.counts?.passed > 0)) {
        result = { ...result, code: 1, error: 'No tests passed. The recipe requires at least one passing test.' };
      }
      if (!canceled && result.code !== 0) failure = result;
      publish({
        type: 'task-progress', id, outcome: canceled ? 'cancelled' : failure ? 'failed' : 'passed',
        exitCode: result.code, durationMs: result.elapsed, reason: result.error,
        anchor: result.location?.revision ? result.location : undefined,
      });
    }
    canceled ||= isStopping();
    publish({
      ...failure, type: 'exit', code: canceled ? null : failure ? failure.code : 0, stopped: canceled,
      elapsed: Math.round(performance.now() - started), evidence,
    });
  }

  void run().catch(error => {
    publish({ type: 'exit', code: null, elapsed: Math.round(performance.now() - started), error: error.message });
  });
  return {
    stop() {
      stopped = true;
      active?.controller?.stop();
    },
  };
}

module.exports = { startRecipe };
