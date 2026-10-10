// Build input for vendor/codemirror.js (fetch-deps.sh bundles it with esbuild; src/ is not in the release zip).
// app.js imports the bundle lazily, the first time a cell is edited, and mounts one editor at a time.
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine, highlightSpecialChars, dropCursor, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, StreamLanguage, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { sql } from '@codemirror/lang-sql';
import { r } from '@codemirror/legacy-modes/mode/r';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tags as t } from '@lezer/highlight';

// Language by the names app.js uses (highlight.js names); anything else is plain text.
const LANGS = {
  python: () => python(),
  markdown: () => markdown(),
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  sql: () => sql(),
  r: () => StreamLanguage.define(r),
  julia: () => StreamLanguage.define(julia),
  bash: () => StreamLanguage.define(shell),
  shell: () => StreamLanguage.define(shell),
};

// Same palette as the highlight.js rendering (style.css --h-* variables), so light / dark follow the page.
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--h-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: 'var(--h-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.monospace], color: 'var(--h-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)], color: 'var(--h-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.definition(t.className)], color: 'var(--h-title)' },
  { tag: [t.typeName, t.standard(t.variableName), t.namespace], color: 'var(--h-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--h-attr)' },
  { tag: [t.meta, t.processingInstruction, t.tagName, t.annotation], color: 'var(--h-meta)' },
  { tag: t.heading, color: 'var(--h-title)', fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--h-del)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--code-bg)', color: 'var(--fg)', border: '1px solid var(--accent)', borderRadius: '4px', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', lineHeight: '1.5' },
  '.cm-content': { padding: '7px 0', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 10px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--sel)' },
  '.cm-activeLine': { backgroundColor: 'var(--row-alt)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--sel)', outline: '1px solid var(--border-strong)' },
});

/**
 * Mount an editor in `parent`. `keys`: extra key bindings that win over the defaults (run, escape, …);
 * `onChange(text)` fires after every document change.
 */
export function mountEditor(parent, { doc, lang, keys = [], onChange, onBlur }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        Prec.highest(keymap.of(keys)),
        highlightSpecialChars(), history(), drawSelection(), dropCursor(), rectangularSelection(),
        indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(),
        indentUnit.of('    '), EditorState.tabSize.of(4),
        syntaxHighlighting(highlightStyle), theme, EditorView.lineWrapping,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        LANGS[lang]?.() ?? [],
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange?.(u.state.doc.toString()); }),
        EditorView.domEventHandlers({ blur: (e) => { onBlur?.(e); return false; } }),
      ],
    }),
  });
  return view;
}
