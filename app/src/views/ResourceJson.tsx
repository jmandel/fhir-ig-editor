// Compiled resource JSON view (spec §7, M1). Shows the byte-identical SUSHI
// output for the selected resource, read-only, syntax-highlighted via Monaco.

import Editor from '@monaco-editor/react';
import { configureMonaco } from '../editor/monacoSetup';
import type { ResourceView } from './resourceView';
import { resourceIdentity } from './artifactSelection';

configureMonaco();

export function ResourceJson({ resource }: { resource: ResourceView }) {
  return (
    <Editor
      path={`__view__/${encodeURIComponent(resourceIdentity(resource))}.json`}
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
