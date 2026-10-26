import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Banner } from './Banner.tsx';

interface Props {
  children: ReactNode;
  /** Short name of the region, used in the message. */
  label?: string;
}

interface State {
  error: Error | null;
}

/** Contains render errors to one region so the rest of the page keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Render error in ${this.props.label ?? 'component'}:`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Banner
        tone="error"
        title={`${this.props.label ?? 'This section'} failed to display`}
        actions={
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => { this.setState({ error: null }); }}>
            Try again
          </button>
        }
      >
        {this.state.error.message}
      </Banner>
    );
  }
}
