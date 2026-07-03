// File tree: renders the flat path list as a collapsible directory tree.
// Selection drives the active editor model. Per-file error badges come from the
// diagnostics (grouped by file).

import { useMemo } from 'react';

interface Props {
  paths: string[];
  active: string | null;
  errorCounts: Record<string, number>;
  onSelect: (path: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          isFile,
        };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function TreeRow({
  node,
  depth,
  active,
  errorCounts,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  active: string | null;
  errorCounts: Record<string, number>;
  onSelect: (path: string) => void;
}) {
  const kids = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; // dirs first
    return a.name.localeCompare(b.name);
  });
  return (
    <>
      {kids.map((k) =>
        k.isFile ? (
          <div
            key={k.path}
            className={`tree-row file${active === k.path ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onSelect(k.path)}
            title={k.path}
          >
            <span className="tree-icon">{fileIcon(k.name)}</span>
            <span className="tree-name">{k.name}</span>
            {errorCounts[k.path] ? (
              <span className="tree-badge">{errorCounts[k.path]}</span>
            ) : null}
          </div>
        ) : (
          <div key={k.path}>
            <div className="tree-row dir" style={{ paddingLeft: 8 + depth * 14 }}>
              <span className="tree-icon">▸</span>
              <span className="tree-name">{k.name}</span>
            </div>
            <TreeRow
              node={k}
              depth={depth + 1}
              active={active}
              errorCounts={errorCounts}
              onSelect={onSelect}
            />
          </div>
        ),
      )}
    </>
  );
}

function fileIcon(name: string): string {
  if (name.endsWith('.fsh')) return '𝔉';
  if (name.endsWith('.json')) return '{}';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return '⚙';
  if (name.endsWith('.md')) return '¶';
  return '·';
}

export function FileTree({ paths, active, errorCounts, onSelect }: Props) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  if (paths.length === 0) {
    return <div className="tree-empty">No project loaded.</div>;
  }
  return (
    <div className="file-tree">
      <TreeRow
        node={tree}
        depth={0}
        active={active}
        errorCounts={errorCounts}
        onSelect={onSelect}
      />
    </div>
  );
}
