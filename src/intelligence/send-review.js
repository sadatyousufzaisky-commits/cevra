window.reviewConversation = ({ provider, model, messages, labels, maxOutputTokens, cost }) => {
  delete window.reviewConversation;
  document.getElementById('review-heading').textContent = 'Send conversation to ' + provider.label + '?';
  document.getElementById('destination').textContent = `${model} · ${provider.endpoint} · Up to ${maxOutputTokens} output tokens`;
  document.getElementById('review-privacy').textContent = provider.local ?
    'CEVRA sends this request to the Ollama service on this computer after checking that it reports cloud features disabled.' :
    'The OpenAI API may charge your account and retain content under its API data policies.';
  if (cost) {
    const element = document.getElementById('review-cost');
    const usd = micros => '$' + (micros / 1_000_000).toFixed(6);
    const limit = cost.limitCents === null ? '' : ` Daily estimate limit ${usd(cost.limitCents * 10_000)}.`;
    element.textContent = cost.quote ?
      `Reserve ${usd(cost.quote.micros)} using published USD rates checked ${cost.quote.checked}, a local input allowance, and the full output cap. Actual charges may vary.${limit}` :
      'Price unavailable. OpenAI may still charge for this request.';
    element.hidden = false;
  }
  const list = document.getElementById('review-messages');
  for (const [index, message] of messages.entries()) {
    const item = document.createElement('li');
    const role = document.createElement('strong');
    const content = document.createElement('pre');
    role.textContent = labels?.[index] ?? (message.role === 'user' ? 'You' : 'Assistant');
    content.textContent = message.content;
    content.tabIndex = 0;
    item.append(role, content);
    list.append(item);
  }
  return new Promise(resolve => {
    const cancel = document.getElementById('cancel');
    const approve = document.getElementById('approve');
    approve.textContent = 'Send to ' + provider.label;
    cancel.onclick = () => resolve(false);
    approve.onclick = () => resolve(true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') resolve(false); });
    cancel.disabled = approve.disabled = false;
    cancel.focus();
  });
};
