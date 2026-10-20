/**
 * A place you can tap to open in maps: Apple Maps on iPhone, iPad and Mac,
 * Google Maps everywhere else. Only the place itself is searched; a field
 * number shown next to it is not part of the address.
 */
export function mapUrl(place: string): string {
  const q = encodeURIComponent(place.trim());
  const apple = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  return apple ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export default function MapLink({ place, className }: { place: string; className?: string }) {
  if (!place.trim()) return null;
  return (
    <a
      className={`map-link${className ? ` ${className}` : ''}`}
      href={mapUrl(place)}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in maps"
    >
      <span aria-hidden="true">📍</span>
      {place}
    </a>
  );
}
