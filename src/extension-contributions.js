import { closeCompletion, insertCompletionText, pickedCompletion } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { normalizeSource } from './source-text.cjs';

const wordEnd = /[\p{ID_Continue}$]$/u;

function snippetLanguage(path, language) {
  if (language) return language.typescript ? 'typescript' : 'javascript';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.jsonc?$/i.test(path)) return 'json';
  if (/\.(?:md|markdown)$/i.test(path)) return 'markdown';
  return 'plaintext';
}

function luminance(color) {
  const channels = [1, 3, 5].map(offset => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function readableAccent({ background, foreground, accent }) {
  const levels = [luminance(background), luminance(accent)];
  const ratio = (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05);
  return ratio >= 4.5 ? accent : foreground;
}

export function createExtensionContributions({ api, editor, view, themeChoice, builtInTheme, report }) {
  let snippets = new Map();
  let palette;
  let packages = [];
  let request = 0;

  function syncThemeChoice() {
    themeChoice.value = palette?.key ?? builtInTheme();
  }

  function replace(nextPackages, selectedKey) {
    packages = nextPackages;
    const previous = snippets;
    snippets = new Map();
    palette = undefined;
    const group = document.createElement('optgroup');
    group.label = 'Extension editor palettes';
    for (const extension of packages) {
      for (const snippet of extension.snippets) {
        const { language } = snippet;
        const options = snippets.get(language) ?? [];
        snippets.set(language, options);
        const completion = {
          label: snippet.prefix,
          detail: `${extension.id}/${snippet.id}`,
          sortText: `${snippet.prefix} ${extension.id}/${snippet.id}`,
          type: 'text',
          info: snippet.description,
          apply(editorView, picked, from, to) {
            if (snippets.get(language) !== options) return void closeCompletion(editorView);
            editorView.dispatch({
              ...insertCompletionText(editorView.state, normalizeSource(snippet.body), from, to),
              annotations: [pickedCompletion.of(picked), isolateHistory.of('full')],
            });
          },
        };
        options.push(completion);
      }
      for (const option of extension.palettes) {
        group.append(new Option(`${option.label} (${extension.id})`, option.key));
        if (option.key === selectedKey) palette = option;
      }
    }
    if (previous.size) closeCompletion(view);
    themeChoice.querySelector('optgroup')?.remove();
    if (group.childElementCount) themeChoice.append(group);
    syncThemeChoice();
    const colors = palette?.colors;
    for (const key of ['background', 'foreground', 'accent', 'syntax-accent']) {
      const property = `--extension-editor-${key}`;
      if (colors) editor.style.setProperty(property, key === 'syntax-accent' ? readableAccent(colors) : colors[key]);
      else editor.style.removeProperty(property);
    }
    editor.toggleAttribute('data-extension-palette', Boolean(colors));
  }

  async function refresh() {
    const id = ++request;
    try {
      const snapshot = await api.extensionContributions();
      if (id === request) replace(snapshot.packages, snapshot.palette);
    } catch (error) {
      if (id !== request) return;
      replace([], null);
      report(error);
    }
  }

  api.onExtensionContributionsChanged(id => {
    if (!request) return;
    if (packages.some(extension => extension.id === id)) {
      replace(packages.filter(extension => extension.id !== id), palette?.key);
    }
    void refresh();
  });

  return {
    refresh,
    syncThemeChoice,
    source(path, language) {
      const kind = snippetLanguage(path, language);
      return context => {
        const options = snippets.get(kind);
        const { pos, state } = context;
        if (!options?.length || state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
        const line = state.doc.lineAt(pos);
        // Include one preceding Unicode code point to avoid matching inside a longer identifier.
        const tail = state.sliceDoc(Math.max(line.from, pos - 34), pos);
        for (let length = Math.min(32, tail.length); length > 0; length--) {
          const query = tail.slice(-length);
          if (wordEnd.test(tail.slice(0, -length))) continue;
          const matches = options.filter(option => option.label.startsWith(query));
          if (matches.length) return { from: pos - length, options: matches, filter: false, map: () => null };
        }
        return context.explicit ? { from: pos, options, filter: false, map: () => null } : null;
      };
    },
  };
}
