window.reviewConversation = ({ model, endpoint, messages, labels, maxOutputTokens }) => {
  delete window.reviewConversation;
  document.getElementById('destination').textContent = `${model} · ${endpoint} · Up to ${maxOutputTokens} output tokens`;
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
    cancel.onclick = () => resolve(false);
    approve.onclick = () => resolve(true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') resolve(false); });
    cancel.disabled = approve.disabled = false;
    cancel.focus();
  });
};
