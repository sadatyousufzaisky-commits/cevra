const api = window.intelligenceMock;
const form = document.getElementById('prompt-form');
const model = document.getElementById('model');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const retry = document.getElementById('retry');
const status = document.getElementById('status');
const output = document.getElementById('response');
const usage = document.getElementById('usage');
let current;
let last;

function busy(active) {
  model.disabled = prompt.disabled = send.disabled = active;
  stop.disabled = !active || !current?.id;
}

async function run(input) {
  if (current) return;
  const request = { stopped: false };
  current = request;
  last = input;
  busy(true);
  retry.hidden = true;
  status.textContent = 'Starting request…';
  output.textContent = '';
  usage.textContent = '';
  try {
    request.id = await api.start(input);
    stop.disabled = false;
    status.textContent = 'Streaming…';
    while (!request.stopped) {
      const event = await api.next(request.id);
      if (request.stopped) break;
      if (event.kind === 'text.delta') output.append(event.text);
      if (event.kind === 'usage') usage.textContent = `Simulated usage · ${event.inputTokens} input / ${event.outputTokens} output tokens`;
      if (event.kind === 'complete') {
        status.textContent = 'Response complete.';
        break;
      }
      if (event.kind === 'error') {
        status.textContent = event.message ?? 'The mock provider could not complete the request.';
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
      status.textContent = 'Request stopped.';
      retry.hidden = false;
    }
    current = undefined;
    busy(false);
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (prompt.value.trim()) void run({ modelId: model.value, prompt: prompt.value });
});
stop.addEventListener('click', () => {
  if (!current?.id || current.stopped) return;
  current.stopped = true;
  stop.disabled = true;
  status.textContent = 'Stopping…';
  void api.stop(current.id).catch(() => {});
});
retry.addEventListener('click', () => {
  model.value = last.modelId;
  prompt.value = last.prompt;
  void run(last);
});
api.models().then(catalog => {
  for (const item of catalog.models) model.append(new Option(item.label, item.id));
  busy(false);
  status.textContent = 'Ready.';
  prompt.focus();
}).catch(() => { status.textContent = 'The mock model is unavailable.'; });
