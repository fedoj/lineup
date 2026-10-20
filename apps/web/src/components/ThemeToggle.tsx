import type { ThemeChoice } from '../lib/theme';

const OPTIONS: Array<{ id: ThemeChoice; label: string; icon: string; title: string }> = [
  { id: 'system', label: 'Auto', icon: '◐', title: 'Match system theme' },
  { id: 'light', label: 'Light', icon: '☀', title: 'Light theme' },
  { id: 'dark', label: 'Dark', icon: '☾', title: 'Dark theme' },
];

export default function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (c: ThemeChoice) => void;
}) {
  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          className={o.id === choice ? 'on' : ''}
          aria-pressed={o.id === choice}
          title={o.title}
          onClick={() => onChange(o.id)}
        >
          <span aria-hidden="true">{o.icon}</span>
          <span className="theme-toggle-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
