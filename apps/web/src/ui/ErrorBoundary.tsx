import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown in the fallback, e.g. "This channel". */
  label?: string;
}

interface State {
  failed: boolean;
}

/** Keeps a crash in one view from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("view crashed", error, info.componentStack);
  }

  retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert">
        <p>{this.props.label ?? "This view"} hit a problem and could not be shown.</p>
        <button onClick={this.retry}>Try again</button>
      </div>
    );
  }
}
