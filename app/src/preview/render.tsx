/** Browser host adapter for Cycle's shared pure renderer and content policy. */
import { CycleSiteRenderer } from '@cycle/core/renderer';
import type {
  CycleOutputDescriptor,
  PageDescriptor as SharedPageDescriptor,
  RenderedOutput,
  RenderedPage,
} from '@cycle/core/renderer';
import { createCycleContentRenderer } from '@cycle/core/content';
import type { SiteBuildView } from '@cycle/core/site-build';
import { includes } from '@cycle/project/includes';
import { project } from '@cycle/project';

export interface PageDescriptor {
  file: string;
  title: string;
  kind: 'narrative' | 'artifacts' | 'profile' | 'valueset' | 'codesystem' | 'example' | 'generic';
}

export interface CyclePreviewRenderer {
  listPages(): PageDescriptor[];
  listOutputs(): CycleOutputDescriptor[];
  renderPage(file: string): RenderedPage;
  renderOutput(file: string): RenderedOutput;
}

function previewPage(page: SharedPageDescriptor): PageDescriptor {
  // The editor protocol predates these additional static Cycle page kinds;
  // retain its coarse categories without forking selection or rendering.
  if (page.kind === 'profile-companion') return { ...page, kind: 'profile' };
  if (page.kind === 'toc' || page.kind === 'validation') {
    return { ...page, kind: 'narrative' };
  }
  switch (page.kind) {
    case 'narrative':
    case 'artifacts':
    case 'profile':
    case 'valueset':
    case 'codesystem':
    case 'example':
    case 'generic':
      return { ...page, kind: page.kind };
  }
}

/** Construct one renderer per immutable worker build. No active-store or content
 * singleton is retained in this module. */
export function createCycleRenderer(view: SiteBuildView): CyclePreviewRenderer {
  const renderer = new CycleSiteRenderer(view, {
    content: createCycleContentRenderer(),
    includes,
    project,
  });
  return {
    listPages: () => renderer.listPages().map(previewPage),
    listOutputs: () => renderer.listOutputs(),
    renderPage: (file) => renderer.renderPage(file),
    renderOutput: (file) => renderer.renderOutput(file),
  };
}
