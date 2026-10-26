import { LoaderCircle } from 'lucide-react';

export function Spinner({ size = 20 }: { size?: number }) {
  return <LoaderCircle className="spinner" size={size} aria-hidden="true" />;
}

/** Announced loading state for a region or page. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
