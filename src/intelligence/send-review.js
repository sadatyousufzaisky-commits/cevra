window.reviewConversation = ({ provider, model, messages, labels, maxOutputTokens }) => {
  delete window.reviewConversation;
  document.getElementById('review-heading').textContent = 'Send conversation to ' + provider.label + '?';
  document.getElementById('destination').textContent = `${model} · ${provider.endpoint} · Up to ${maxOutputTokens} output tokens`;
  document.getElementById('review-privacy').textContent = provider.local ?
    'CEVRA sends this request to the Ollama service on this computer after checking that it reports cloud features disabled.' :
    'The OpenAI API may charge your account and retain content under its API data policies.';
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
