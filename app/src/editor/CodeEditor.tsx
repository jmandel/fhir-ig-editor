// The Monaco editor pane. One model per open file (multi-file model, spec §3),
// diagnostics projected as markers on the active file. Debounced edits are lifted
// to the parent via onChange; the parent owns the compile scheduling.

import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';
import { configureMonaco } from './monacoSetup';
import { registerFsh, FSH_LANGUAGE_ID } from './fshLanguage';
import type { Diagnostic } from '../worker/protocol';

configureMonaco();

function languageOf(path: string): string {
  if (path.endsWith('.fsh')) return FSH_LANGUAGE_ID;
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

interface Props {
  path: string;
  value: string;
  /** Diagnostics for THIS file (already filtered by path). */
  diagnostics: Diagnostic[];
  onChange: (text: string) => void;
  /** Jump the cursor to a line (from a diagnostics-panel click). */
  revealLine?: number;
}

export function CodeEditor({ path, value, diagnostics, onChange, revealLine }: Props) {
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoNS | null>(null);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    registerFsh(monaco);
  };

  // Project diagnostics → markers whenever they (or the model) change.
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const markers: MonacoNS.editor.IMarkerData[] = diagnostics.map((d) => ({
      severity:
        d.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.line ?? 1,
      startColumn: 1,
      endLineNumber: d.line ?? 1,
      endColumn: model.getLineMaxColumn(Math.min(d.line ?? 1, model.getLineCount())),
    }));
    monaco.editor.setModelMarkers(model, 'fsh-engine', markers);
  }, [diagnostics, path, value]);

  // Reveal a line when asked (diagnostics-panel navigation).
  useEffect(() => {
    if (revealLine && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
      editorRef.current.focus();
    }
  }, [revealLine]);

  return (
    <Editor
      key={path}
      path={path}
      language={languageOf(path)}
      value={value}
      onMount={onMount}
      onChange={(v) => onChange(v ?? '')}
      theme="vs-dark"
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
        wordWrap: 'off',
      }}
    />
  );
}
