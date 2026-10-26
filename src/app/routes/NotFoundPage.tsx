import { ArrowLeft } from 'lucide-react';
import { ButtonLink } from '../../components/ui/index.ts';

export function NotFoundPage() {
  return (
    <div className="page page--narrow notfound">
      <p className="notfound__code" aria-hidden="true">
        404
      </p>
      <h1>Page not found</h1>
      <p className="notfound__body">That page does not exist. The link may be old, or the program may have been unpublished.</p>
      <div className="row notfound__actions">
        <ButtonLink to="/" icon={<ArrowLeft size={17} aria-hidden="true" />}>
          Go to the home page
        </ButtonLink>
        <ButtonLink to="/programs" variant="secondary">
          Browse programs
        </ButtonLink>
      </div>
    </div>
  );
}
