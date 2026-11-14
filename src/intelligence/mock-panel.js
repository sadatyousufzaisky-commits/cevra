const api = window.intelligenceMock;
const form = document.getElementById('prompt-form');
const model = document.getElementById('model');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const propose = document.getElementById('propose-edit');
const stop = document.getElementById('stop');
const retry = document.getElementById('retry');
const clear = document.getElementById('clear');
const status = document.getElementById('status');
const output = document.getElementById('response');
const usage = document.getElementById('usage');
const note = document.getElementById('provider-note');
const conversation = document.getElementById('conversation');
const history = document.getElementById('history');
const models = new Map();
let current;
let last;
let clearing = false;

function busy(active) {
  model.disabled = prompt.disabled = send.disabled = active;
  propose.disabled = active || models.get(model.value) !== 'openai';
  stop.disabled = !active || !current?.id;
  clear.disabled = active;
}

function showProvider() {
  const live = models.get(model.value) === 'openai';
  note.textContent = live ?
    'OpenAI API. Sending includes your prompt and the completed turns below. API charges may apply.' :
    'Offline mock. Responses and usage are simulated.';
  output.setAttribute('aria-label', live ? 'Model response' : 'Mock response');
  propose.hidden = !live;
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
    history.replaceChildren();
    conversation.hidden = true;
    output.textContent = usage.textContent = '';
    status.textContent = 'Ready.';
    showProvider();
    return true;
  } catch { status.textContent = 'The conversation could not be cleared.'; }
  finally { clearing = false; busy(false); }
}

async function run(input) {
  if (current || clearing) return;
  const request = { stopped: false };
  const live = models.get(input.modelId) === 'openai';
  current = request;
  last = input;
  busy(true);
  retry.hidden = true;
  status.textContent = 'Starting request…';
  try {
    const started = await api.start(input);
    if (!started || typeof started !== 'string') {
      status.textContent = started?.message ?? 'Send canceled.';
      return;
    }
    request.id = started;
    output.textContent = '';
    usage.textContent = '';
    stop.disabled = false;
    status.textContent = 'Streaming…';
    while (!request.stopped) {
      const event = await api.next(request.id);
      if (request.stopped) break;
      if (event.kind === 'text.delta') output.append(event.text);
      if (event.kind === 'usage') usage.textContent =
        `${live ? 'OpenAI usage' : 'Simulated usage'} · ${event.inputTokens} input / ${event.outputTokens} output tokens`;
      if (event.kind === 'complete') {
        if (live && event.retained && output.textContent) remember(input.prompt, output.textContent);
        if (live && !usage.textContent) usage.textContent = 'OpenAI usage unavailable.';
        status.textContent = event.proposalId ? 'Edit proposal ready. Review it in the workbench.' :
          event.finishReason === 'length' ? 'Response reached the output limit.' : 'Response complete.';
        if (live) document.dispatchEvent(new Event('intelligence-connection-changed'));
        break;
      }
      if (event.kind === 'proposal-invalid') {
        status.textContent = event.message;
        retry.hidden = false;
        break;
      }
      if (event.kind === 'error') {
        status.textContent = event.message ?? 'The provider could not complete the request.';
        if (live && event.code === 'AUTH_INVALID') {
          status.textContent = 'OpenAI connection unavailable. Check or replace the key in Provider connections.';
          document.dispatchEvent(new Event('intelligence-connection-changed'));
        }
        retry.hidden = !event.retryable;
        break;
      }
    }
  } catch {
    status.textContent = request.id ? 'The request could not continue.' : 'Enter a valid prompt of up to 8 KiB.';
    retry.hidden = !request.id;
    if (request.id) await api.stop(request.id).catch(() => {});
  } finally {
    if (request.stopped) {
      status.textContent = live ? 'Request stopped. OpenAI may charge for usage already processed.' : 'Request stopped.';
      retry.hidden = false;
    }
    current = undefined;
    busy(false);
    if (request.stopped || document.activeElement === document.body) prompt.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (prompt.value.trim()) void run({ modelId: model.value, prompt: prompt.value,
    ...(event.submitter?.id === 'propose-edit' ? { mode: 'patch' } : {}) });
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
  model.value = last.modelId;
  prompt.value = last.prompt;
  void run(last);
});
clear.addEventListener('click', async () => {
  if (await reset()) { prompt.value = ''; prompt.focus(); }
});
model.addEventListener('change', () => { void reset(true); });
api.models().then(catalogs => {
  for (const catalog of catalogs) {
    for (const item of catalog.models) {
      models.set(item.id, catalog.providerId);
      model.append(new Option(item.label, item.id));
    }
  }
  showProvider();
  busy(false);
  status.textContent = 'Ready.';
  prompt.focus();
}).catch(() => { status.textContent = 'The model catalog is unavailable.'; });
