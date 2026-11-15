import { javascript } from '@codemirror/lang-javascript';
import { getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { colorModeExtension, editorTheme } from './editor-theme.js';

export function createEditorReview() {
  const dialog = document.getElementById('editor-review');
  const host = document.getElementById('review-source');
  const summary = document.getElementById('review-summary');
  const legend = document.getElementById('review-legend');
  const previous = document.getElementById('review-previous');
  const next = document.getElementById('review-next');
  const close = document.getElementById('review-close');
  let view;

  function navigate(command) {
    if (!view) return;
    command(view);
    view.focus();
  }

  previous.onclick = () => navigate(goToPreviousChunk);
  next.onclick = () => navigate(goToNextChunk);
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    view?.destroy();
    view = undefined;
    host.replaceChildren();
  });

  return {
    open(tab, { dark, options }) {
      const { doc } = tab.state;
      const identicalText = doc.eq(tab.savedDoc);
      document.getElementById('review-file').textContent = tab.path;
      host.hidden = legend.hidden = previous.hidden = next.hidden = identicalText;
      summary.textContent = identicalText ? 'Line endings or the byte-order mark changed.' : 'Comparing with the last verified disk revision.';
      dialog.showModal();
      if (identicalText) return;

      host.style.setProperty('--editor-font-size', (options?.fontSize ?? 14) + 'px');
      const fonts = { default: 'var(--mono)', consolas: 'Consolas, monospace', courier: '"Courier New", monospace' };
      host.style.setProperty('--editor-font', fonts[options?.fontFamily] ?? fonts.default);
      view = new EditorView({
        doc,
        parent: host,
        extensions: [
          editorTheme,
          colorModeExtension(dark),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': 'File comparison', 'aria-readonly': 'true', tabindex: '0' }),
          options?.lineNumbers === false ? [] : lineNumbers(),
          tab.language ? javascript({ typescript: tab.language.typescript, jsx: tab.language.jsx }) : [],
          unifiedMergeView({ original: tab.savedDoc, mergeControls: false, syntaxHighlightDeletions: false,
            diffConfig: { scanLimit: 500, timeout: 75 } }),
        ],
      });
      const { chunks } = getChunks(view.state);
      summary.textContent += ' ' + chunks.length + (chunks.length === 1 ? ' changed section.' : ' changed sections.');
      if (chunks.some(chunk => !chunk.precise)) summary.textContent += ' Large changes are shown as blocks.';
      navigate(goToNextChunk);
    },
  };
}
