import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Banner, Button, DataTable, Dialog, EmptyState, ErrorBoundary, StatusBadge, TextField } from '../../src/components/ui/index.ts';

describe('TextField', () => {
  it('associates label, hint and error with the input', () => {
    render(<TextField label="Email" hint="We send a code" error="Enter a valid email" required />);
    const input = screen.getByRole('textbox', { name: /Email/ });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/We send a code.*Enter a valid email/);
  });
});

describe('Button', () => {
  it('disables itself and announces busy while loading', () => {
    const onClick = vi.fn();
    render(<Button loading loadingLabel="Saving…" onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Banner and badges', () => {
  it('uses role=alert for errors and role=status otherwise', () => {
    render(
      <>
        <Banner tone="error" title="Broken" />
        <Banner tone="info" title="FYI" />
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Broken');
    expect(screen.getByRole('status')).toHaveTextContent('FYI');
  });

  it('badges always carry text, not just colour', () => {
    render(<StatusBadge tone="pending">Pending review</StatusBadge>);
    expect(screen.getByText('Pending review')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  it('renders the empty state when there are no rows', () => {
    render(<DataTable caption="Rows" rows={[]} rowKey={() => ''} columns={[]} empty={<EmptyState title="Nothing here" />} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders a captioned table with column headers', () => {
    render(
      <DataTable
        caption="Weeks"
        rows={[{ id: 'w1', seats: 12 }]}
        rowKey={(r) => r.id}
        columns={[
          { key: 'id', header: 'Week', render: (r) => r.id },
          { key: 'seats', header: 'Seats', numeric: true, render: (r) => r.seats },
        ]}
      />,
    );
    expect(screen.getByRole('table', { name: 'Weeks' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Seats' })).toBeInTheDocument();
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => { setOpen(true); }}>Open</button>
        <Dialog open={open} onClose={() => { setOpen(false); }} title="Confirm">
          Are you sure?
        </Dialog>
      </>
    );
  }

  it('opens with a labelled title and closes from its close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('heading', { name: 'Confirm' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('heading', { name: 'Confirm' })).toBeNull();
  });
});

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new Error('kaboom');
  }

  it('contains a render error and shows a retry', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary label="Widget">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Widget failed to display');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
