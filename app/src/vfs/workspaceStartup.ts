// Page-process owner for the repository and the initial project read. React
// StrictMode may replay App's boot effect in development; opening OPFS twice
// would create two mutable Workspace owners and duplicate timeline spans.

import type { BuildEvent } from '../worker/protocol';
import { epochMs, spanEvent } from '../performance/timeline';
import { WorkspaceRepository, type Workspace } from './workspace';

export interface WorkspaceRepositoryLike {
  open(projectId: string): Promise<Workspace | null>;
}

export interface WorkspaceStartupResult<R extends WorkspaceRepositoryLike> {
  repository: R;
  workspace: Workspace | null;
}

export type WorkspaceStartupReporter = (event: BuildEvent) => void;

function emitWorkspaceEvent(report: WorkspaceStartupReporter, event: BuildEvent): void {
  try {
    report(event);
  } catch (error) {
    console.error('workspace startup observer failed', error);
  }
}

/** One repository per page process and one initial read per project. Failed
 * startup remains failed: App presents an explicit reload instead of silently
 * creating a second repository with ambiguous ownership. */
export class WorkspaceStartup<R extends WorkspaceRepositoryLike> {
  private repositoryPromise: Promise<R> | null = null;
  private readonly openPromises = new Map<string, Promise<WorkspaceStartupResult<R>>>();

  constructor(private readonly createRepository: () => Promise<R>) {}

  open(
    projectId: string,
    report: WorkspaceStartupReporter,
  ): Promise<WorkspaceStartupResult<R>> {
    const existing = this.openPromises.get(projectId);
    if (existing) return existing;

    if (!this.repositoryPromise) {
      const repositoryStartedMs = epochMs();
      this.repositoryPromise = this.createRepository().then((repository) => {
        emitWorkspaceEvent(report, spanEvent('workspace.repository-open', 'window', repositoryStartedMs, {
          stage: 'project-store',
          message: 'Opened workspace repository.',
        }));
        return repository;
      });
    }

    const pending = this.repositoryPromise.then(async (repository) => {
      const workspaceStartedMs = epochMs();
      const workspace = await repository.open(projectId);
      emitWorkspaceEvent(report, spanEvent('workspace.open', 'window', workspaceStartedMs, {
        stage: workspace ? 'project-cache-hit' : 'project-store',
        message: workspace ? 'Restored project workspace.' : 'No persisted project workspace.',
        fromCache: Boolean(workspace),
      }));
      return { repository, workspace };
    });
    this.openPromises.set(projectId, pending);
    return pending;
  }
}

export const workspaceStartup = new WorkspaceStartup(() => WorkspaceRepository.create());
