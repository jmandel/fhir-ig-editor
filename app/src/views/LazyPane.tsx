import {
  Component,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from 'react';

interface Props {
  children: ReactNode;
  loading: string;
}

interface State {
  error: string | null;
}

/** Keeps an optional UI capability's loading or import failure inside its pane. */
export class LazyPane extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('lazy pane failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="lazy-pane-state lazy-pane-error" role="alert">
          <span>Couldn’t load this editor: {this.state.error}</span>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload editor
          </button>
        </div>
      );
    }
    return (
      <Suspense fallback={<div className="lazy-pane-state" role="status">{this.props.loading}</div>}>
        {this.props.children}
      </Suspense>
    );
  }
}
