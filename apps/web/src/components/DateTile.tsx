/**
 * The big date tile of a calendar card ("SUN / 18 / OCT"). It only shows in
 * lists styled as cards (`.cal-cards`); elsewhere the plain date line shows.
 */
export function DateTile({ date }: { date: string | null }) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  return (
    <span className="when-tile" aria-hidden="true">
      <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <strong>{d}</strong>
      <span>{day.toLocaleDateString(undefined, { month: 'short' })}</span>
    </span>
  );
}
