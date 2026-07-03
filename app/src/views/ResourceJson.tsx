// Compiled resource JSON view (spec §7, M1). Shows the byte-identical SUSHI
// output for the selected resource, read-only, syntax-highlighted via Monaco.

import Editor from '@monaco-editor/react';
import { configureMonaco } from '../editor/monacoSetup';
import type { CompiledResource } from '../worker/protocol';

configureMonaco();

export function ResourceJson({ resource }: { resource: CompiledResource }) {
  return (
    <Editor
      path={`__view__/${resource.filename}`}
      language="json"
      value={resource.text}
      theme="vs-dark"
      options={{
        readOnly: true,
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
      }}
    />
  );
}
