import { Moon, Sun } from 'lucide-react';
import { switchTheme, useTheme } from '../lib/theme.ts';

/** Black / white theme toggle: the new theme grows as a circle from the button. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next === 'dark' ? 'dark' : 'light'} theme`;
  return (
    <button
      type="button"
      className={['theme-toggle', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        switchTheme(next, b.left + b.width / 2, b.top + b.height / 2);
      }}
    >
      <span className="theme-toggle__icon" data-theme-icon={theme}>
        {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
      </span>
    </button>
  );
}
