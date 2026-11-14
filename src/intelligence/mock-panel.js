const api = window.intelligenceMock;
const form = document.getElementById('prompt-form');
const model = document.getElementById('model');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const propose = document.getElementById('propose-edit');
const planCoding = document.getElementById('plan-coding-task');
const stop = document.getElementById('stop');
const retry = document.getElementById('retry');
const clear = document.getElementById('clear');
const status = document.getElementById('status');
const output = document.getElementById('response');
const usage = document.getElementById('usage');
const responseCost = document.getElementById('response-cost');
const note = document.getElementById('provider-note');
const conversation = document.getElementById('conversation');
const history = document.getElementById('history');
const models = new Map();
const task = document.getElementById('task-model-profile');
const taskStatus = document.getElementById('task-model-status');
const fallback = document.getElementById('choose-fallback');
const localForm = document.getElementById('local-model-form');
const profileForm = document.getElementById('model-profile-form');
const disconnect = document.getElementById('disconnect-local');
const budgetPanel = document.getElementById('usage-budget');
const budgetForm = document.getElementById('budget-form');
const budgetLimit = document.getElementById('budget-limit');
const budgetStatus = document.getElementById('budget-status');
let profile = {};
let manualRoute = false;
let catalogReady = false;
let current;
let last;
let clearing = false;
let agent = { stage: 'unavailable' };
let agentRoute;
const coding = document.getElementById('coding-task');
const codingStatus = document.getElementById('coding-status');
const codingNext = document.getElementById('coding-next');
const codingStop = document.getElementById('coding-stop');
const codingActive = () => ['plan', 'baseline', 'proposal', 'generating', 'review', 'save', 'verification'].includes(agent.stage);
const keyFor = (providerId, modelId) => providerId === 'ollama' ? 'ollama|' + modelId : modelId;
const selected = () => models.get(model.value);
const usd = micros => '$' + (micros / 1_000_000).toFixed(6);

function showBudget(data) {
  const unpriced = data.unpriced ? ` · ${data.unpriced} unpriced request${data.unpriced === 1 ? '' : 's'}` : '';
  document.getElementById('budget-today').textContent = `${data.day} UTC · ${usd(data.used)} estimated or reserved${unpriced}`;
}

async function refreshBudget(loadLimit = false) {
  const result = await api.usageBudget();
  if (!result.ok) { budgetStatus.textContent = result.message; return; }
  showBudget(result.value);
  if (loadLimit) budgetLimit.value = result.value.limitCents === null ? '' : (result.value.limitCents / 100).toFixed(2);
}

budgetPanel.addEventListener('toggle', () => {
  if (budgetPanel.open) void refreshBudget(true).catch(() => { budgetStatus.textContent = 'Usage totals are unavailable.'; });
});
budgetForm.addEventListener('submit', async event => {
  event.preventDefault();
  budgetForm.inert = true;
  budgetStatus.textContent = 'Saving daily limit…';
  try {
    const result = await api.saveUsageLimit(budgetLimit.value === '' ? null : Math.round(budgetLimit.valueAsNumber * 100));
    if (result.ok) showBudget(result.value);
    budgetStatus.textContent = result.ok ? 'Daily limit saved.' : result.message;
  } catch { budgetStatus.textContent = 'The daily limit could not be saved.'; }
  finally { budgetForm.inert = false; }
});

function busy(active) {
  model.disabled = active || !catalogReady;
  task.disabled = active || codingActive();
  prompt.disabled = active || codingActive();
  send.disabled = active || codingActive() || !selected();
  planCoding.disabled = propose.disabled = send.disabled || selected()?.providerId === 'mock';
  stop.disabled = !active || !current?.id;
  clear.disabled = active;
}

function showProvider() {
  const provider = selected()?.providerId;
  note.textContent = {
    openai: 'OpenAI API. Review each request before sending. API charges may apply.',
    ollama: 'Ollama on this computer. Review each request before sending.',
    mock: 'Offline mock. Responses and usage are simulated.',
  }[provider] ?? 'Choose an available model.';
  output.setAttribute('aria-label', provider === 'mock' ? 'Mock response' : 'Model response');
  propose.hidden = !provider || provider === 'mock' || !['chat', 'patch'].includes(task.value);
  planCoding.hidden = !provider || provider === 'mock' || agent.stage === 'unavailable' || !['chat', 'coding'].includes(task.value);
  send.hidden = task.value === 'patch' || task.value === 'coding';
  send.textContent = task.value === 'explain' ? 'Explain code' : 'Send';
}

function routeFor(kind, override = false) {
  if (override || !profile[kind]) return selected();
  const { providerId, modelId } = profile[kind];
  return models.get(keyFor(providerId, modelId));
}

function selectTaskRoute() {
  const preferred = profile[task.value];
  if (!preferred) {
    taskStatus.textContent = '';
    if (!selected()) model.value = models.keys().next().value ?? '';
  } else {
    const key = keyFor(preferred.providerId, preferred.modelId);
    model.value = models.has(key) ? key : '';
    taskStatus.textContent = models.has(key) ? '' :
      'Saved model unavailable. Connect its provider or choose another model.';
  }
  fallback.hidden = Boolean(selected());
}

function renderCatalog(catalogs) {
  const previous = model.value;
  models.clear();
  model.replaceChildren(new Option('Choose a model', '', false, false));
  for (const catalog of catalogs) {
    for (const item of catalog.models) {
      const route = { providerId: catalog.providerId, modelId: item.id, label: item.label };
      const key = keyFor(route.providerId, route.modelId);
      models.set(key, route);
      model.append(new Option(catalog.providerId === 'ollama' ? 'Ollama · ' + item.label : item.label, key));
    }
  }
  catalogReady = true;
  model.value = models.has(previous) ? previous : '';
  if (!manualRoute) selectTaskRoute();
  else if (!selected()) {
    taskStatus.textContent = 'The selected model is unavailable. Choose another model.';
    fallback.hidden = false;
  }
  for (const kind of ['chat', 'explain', 'patch', 'coding']) {
    const select = profileForm.elements[kind];
    select.replaceChildren(new Option('Use the model picker', ''));
    const saved = profile[kind];
    const key = saved ? keyFor(saved.providerId, saved.modelId) : '';
    for (const [id, route] of models) {
      if (route.providerId === 'mock' && (kind === 'patch' || kind === 'coding')) continue;
      select.append(new Option(route.providerId + ' · ' + route.label, id));
    }
    if (key && !models.has(key)) select.append(new Option(saved.providerId + ' · ' + saved.modelId + ' (unavailable)', key));
    select.value = key;
  }
  disconnect.disabled = ![...models.values()].some(item => item.providerId === 'ollama');
  showProvider();
  busy(Boolean(current) || clearing);
}

function remember(promptText, responseText) {
  const turn = document.createElement('li');
  for (const [label, text] of [['You', promptText], ['Assistant', responseText]]) {
    const heading = document.createElement('strong');
    const block = document.createElement('pre');
    heading.textContent = label;
    block.textContent = text;
    block.tabIndex = 0;
    turn.append(heading, block);
  }
  history.append(turn);
  conversation.hidden = false;
}

async function reset(preserveAttachments = false) {
  if (current || clearing) return;
  clearing = true;
  busy(true);
  try {
    if (preserveAttachments) await api.switchModel();
    else await api.clear();
    last = undefined;
    retry.hidden = true;
    fallback.hidden = Boolean(selected());
    history.replaceChildren();
    conversation.hidden = true;
    output.textContent = usage.textContent = responseCost.textContent = '';
    status.textContent = 'Ready.';
    showProvider();
    return true;
  } catch { status.textContent = 'The conversation could not be cleared.'; }
  finally { clearing = false; busy(false); }
}

async function run(input) {
  if (current || clearing) return;
  const request = { stopped: false };
  const cloud = input.providerId === 'openai';
  const real = input.providerId !== 'mock';
  const usageLabel = cloud ? 'OpenAI usage' : real ? 'Ollama usage' : 'Simulated usage';
  current = request;
  last = input;
  busy(true);
  retry.hidden = true;
  fallback.hidden = true;
  status.textContent = 'Starting request…';
  try {
    const started = await api.start(input);
    if (!started || typeof started !== 'string') {
      status.textContent = started?.message ?? 'Send canceled.';
      if (started?.fallback && input.mode !== 'agent') fallback.hidden = false;
      if (started?.retry && input.mode !== 'agent') retry.hidden = false;
      return;
    }
    request.id = started;
    output.textContent = '';
    usage.textContent = '';
    responseCost.textContent = '';
    stop.disabled = false;
    status.textContent = 'Streaming…';
    while (!request.stopped) {
      const event = await api.next(request.id);
      if (request.stopped) break;
      if (event.kind === 'text.delta') output.append(event.text);
      if (event.kind === 'usage') usage.textContent =
        `${usageLabel} · ${event.inputTokens} input / ${event.outputTokens} output tokens`;
      if (cloud && event.cost) {
        responseCost.textContent = event.cost.actual !== null ? `${usd(event.cost.actual)} estimated from reported usage.` :
          event.cost.estimate !== null ? `Usage unavailable. ${usd(event.cost.estimate)} remains reserved.` : 'Price unavailable.';
        if (event.cost.actual > event.cost.estimate) responseCost.textContent += ' Reported usage exceeded the reservation.';
      }
      if (event.kind === 'complete') {
        if (real && event.retained && output.textContent) remember(input.prompt, output.textContent);
        if (real && !usage.textContent) usage.textContent = usageLabel + ' unavailable.';
        status.textContent = event.proposalId ? 'Edit proposal ready. Review it in the workbench.' :
          event.finishReason === 'length' ? 'Response reached the output limit.' : 'Response complete.';
        if (cloud) document.dispatchEvent(new Event('intelligence-connection-changed'));
        break;
      }
      if (event.kind === 'proposal-invalid') {
        status.textContent = event.message;
        retry.hidden = input.mode === 'agent';
        break;
      }
      if (event.kind === 'error') {
        status.textContent = event.message ?? 'The provider could not complete the request.';
        if (cloud && event.code === 'AUTH_INVALID') {
          status.textContent = 'OpenAI connection unavailable. Check or replace the key in Provider connections.';
          document.dispatchEvent(new Event('intelligence-connection-changed'));
        }
        retry.hidden = input.mode === 'agent' || !event.retryable;
        if (input.mode !== 'agent' && ['AUTH_INVALID', 'MODEL_UNSUPPORTED', 'LOCAL_MODE_REQUIRED', 'PROVIDER_UNAVAILABLE',
          'BUDGET_EXCEEDED', 'BUDGET_UNAVAILABLE', 'PRICE_UNAVAILABLE',
          'PROVIDER_TIMEOUT', 'NETWORK_BLOCKED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED'].includes(event.code)) fallback.hidden = false;
        break;
      }
    }
  } catch {
    status.textContent = request.id ? 'The request could not continue.' : 'Enter a valid prompt of up to 8 KiB.';
    retry.hidden = input.mode === 'agent' || !request.id;
    if (request.id) await api.stop(request.id).catch(() => {});
  } finally {
    if (request.stopped) {
      status.textContent = cloud ? 'Request stopped. OpenAI may charge for usage already processed.' : 'Request stopped.';
      retry.hidden = input.mode === 'agent';
    }
    current = undefined;
    busy(false);
    if (cloud && budgetPanel.open) void refreshBudget().catch(() => { budgetStatus.textContent = 'Usage totals are unavailable.'; });
    if (request.stopped || document.activeElement === document.body) prompt.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const kind = event.submitter === planCoding ? 'coding' : event.submitter === propose ? 'patch' : task.value;
  const route = routeFor(kind, manualRoute && kind === task.value);
  if (!route) {
    status.textContent = 'The saved model is unavailable. Choose another model before sending.';
    fallback.hidden = false;
    return;
  }
  const { providerId, modelId } = route;
  if (event.submitter === planCoding) {
    if (!prompt.value.trim()) return;
    void api.prepareAgent({ providerId, modelId, goal: prompt.value }).then(result => {
      if (!result.ok) status.textContent = result.message;
      else {
        agentRoute = result.value;
        renderAgent(agent);
        codingNext.focus();
      }
    }).catch(() => { status.textContent = 'The coding plan could not be prepared.'; });
    return;
  }
  if (prompt.value.trim()) void run({ providerId, modelId, prompt: prompt.value,
    ...(['patch', 'explain'].includes(kind) ? { mode: kind } : {}) });
});
stop.addEventListener('click', () => {
  if (!current?.id || current.stopped) return;
  current.stopped = true;
  stop.disabled = true;
  status.textContent = 'Stopping…';
  void api.stop(current.id).catch(() => {});
});
retry.addEventListener('click', () => {
  if (!last) return;
  model.value = keyFor(last.providerId, last.modelId);
  prompt.value = last.prompt;
  void run(last);
});
clear.addEventListener('click', async () => {
  if (await reset()) { prompt.value = ''; prompt.focus(); }
});
model.addEventListener('change', () => {
  manualRoute = true;
  taskStatus.textContent = '';
  fallback.hidden = true;
  void reset(true);
});
task.addEventListener('change', () => {
  manualRoute = false;
  selectTaskRoute();
  void reset(true);
});
fallback.onclick = () => {
  if (last?.mode === 'patch' || last?.mode === 'explain') task.value = last.mode;
  manualRoute = true;
  showProvider();
  fallback.hidden = true;
  model.focus();
  status.textContent = 'Choose another model and send to review the new destination.';
};
function testSummary(label, result) {
  if (!result) return '';
  return `${label} · ${result.passed} passed, ${result.failed} failed · ${result.observed ? 'Observed revision' : 'Revision unverified'}`;
}

function renderAgent(state) {
  agent = state;
  coding.hidden = !state.goal;
  document.getElementById('coding-goal').textContent = state.goal ?? '';
  document.getElementById('coding-plan-model').textContent = state.goal && agentRoute ?
    `${agentRoute.providerId === 'ollama' ? 'Ollama' : 'OpenAI'} · ${agentRoute.label}` : '';
  document.getElementById('coding-plan').replaceChildren(...(state.goal ? state.plan.map(step => {
    const item = document.createElement('li');
    item.textContent = step;
    return item;
  }) : []));
  document.getElementById('coding-targets').textContent = state.targets?.length ?
    'Plan attachments · ' + state.targets.map(item => item.path + (item.kind === 'selection' ? ':' + item.line : '')).join(', ') : '';
  document.getElementById('coding-steps').textContent = state.goal ? `${state.steps} of ${state.maxSteps} steps started` : '';
  document.getElementById('coding-baseline').textContent = testSummary('Baseline', state.baseline);
  document.getElementById('coding-verification').textContent = testSummary('Verification', state.verification);
  codingStatus.textContent = state.message ?? '';
  codingStop.hidden = !codingActive();
  codingNext.textContent = { plan: 'Run baseline tests', proposal: 'Review proposal request', save: 'Verify saved changes' }[state.stage] ?? '';
  codingNext.hidden = !codingNext.textContent;
  showProvider();
  busy(Boolean(current) || clearing);
}

codingNext.onclick = async () => {
  if (agent.stage === 'proposal') {
    if (agentRoute) await run({ providerId: agentRoute.providerId, modelId: agentRoute.modelId, prompt: agent.goal, mode: 'agent' });
    return;
  }
  codingNext.disabled = true;
  try {
    const result = await api.agentTest();
    if (!result.ok) codingStatus.textContent = result.message;
  } catch { codingStatus.textContent = 'The test step could not start.'; }
  finally { codingNext.disabled = false; }
};
codingStop.onclick = () => { void api.stopAgent(); };
api.onAgentChanged(renderAgent);
api.agentState().then(renderAgent).catch(() => {});
async function configureLocal(action) {
  const localStatus = document.getElementById('local-model-status');
  localForm.inert = true;
  try {
    const result = await action();
    if (!result.ok) { localStatus.textContent = result.message; return; }
    if (selected()?.providerId === 'ollama' && !current && !codingActive()) await reset(true);
    renderCatalog(result.value);
    const local = result.value.find(catalog => catalog.providerId === 'ollama');
    localStatus.textContent = local ? `Discovered ${local.models.length} installed local models.` : 'Ollama disconnected.';
  } catch { localStatus.textContent = 'The local connection could not be changed.'; }
  finally { localForm.inert = false; }
}

localForm.onsubmit = event => {
  event.preventDefault();
  void configureLocal(() => api.connectLocal(document.getElementById('local-port').valueAsNumber));
};
disconnect.onclick = () => { void configureLocal(api.disconnectLocal); };
profileForm.onsubmit = async event => {
  event.preventDefault();
  profileForm.inert = true;
  const profileStatus = document.getElementById('model-profile-status');
  try {
    const value = Object.fromEntries([...new FormData(profileForm)].map(([kind, id]) => {
      const route = models.get(id);
      return [kind, route ? { providerId: route.providerId, modelId: route.modelId } : id ? profile[kind] : null];
    }));
    const saved = await api.saveModelProfile(value);
    if (!saved.ok) { profileStatus.textContent = saved.message; return; }
    profile = saved.value;
    if (!current && !codingActive()) {
      manualRoute = false;
      selectTaskRoute();
      await reset(true);
    }
    profileStatus.textContent = 'Model profiles saved.';
  } catch { profileStatus.textContent = 'Model profiles could not be saved.'; }
  finally { profileForm.inert = false; }
};
Promise.all([api.models(), api.localStatus(), api.modelProfile()]).then(([catalogs, local, saved]) => {
  if (saved.ok) profile = saved.value;
  document.getElementById('local-port').value = local.defaultPort;
  budgetPanel.hidden = !local.enabled;
  task.hidden = taskStatus.hidden = document.getElementById('task-model-label').hidden =
    document.getElementById('models-and-local').hidden = !local.enabled;
  renderCatalog(catalogs);
  status.textContent = 'Ready.';
  prompt.focus();
}).catch(() => { status.textContent = 'The model catalog is unavailable.'; });
