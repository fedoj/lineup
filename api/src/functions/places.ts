import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';

/**
 * Find a place for a game, practice or event location, so the map link that
 * every location becomes points at the right spot.
 *
 * Uses OpenStreetMap's free Nominatim search (no key, no cost) on an explicit
 * "Find" tap, never per keystroke, as its usage policy requires: one request
 * per second at most across this instance, a clear User-Agent, results cached
 * and attributed to OpenStreetMap in the app. Only the text typed into the
 * location box is sent; nothing about the person or the team.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Lineup/1.0 (https://lineup.mahoul.io; support@mahoul.io)';
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;

interface Place {
  /** The full address, ready to save as the location. */
  label: string;
  /** A shorter first line, for the list. */
  name: string;
  lat: number;
  lon: number;
}

const cache = new Map<string, { at: number; places: Place[] }>();
let lastCall = 0;

async function politeFetch(url: string): Promise<Response> {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
}

export async function placesHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const q = String(req.query.get('q') ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (q.length < 3) return { status: 400, jsonBody: { error: 'Type at least 3 letters of the place or address.' } };
    const lang = String(req.query.get('lang') ?? 'en').slice(0, 10);
    const key = `${lang}|${q.toLowerCase()}`;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { status: 200, jsonBody: { places: hit.places, source: 'OpenStreetMap' } };

    const url = `${ENDPOINT}?${new URLSearchParams({
      q,
      format: 'jsonv2',
      addressdetails: '0',
      limit: '5',
      'accept-language': lang,
    }).toString()}`;
    const res = await politeFetch(url);
    if (!res.ok) {
      ctx.warn('places lookup failed', res.status);
      return { status: 502, jsonBody: { error: 'Address search is busy. Try again in a moment.' } };
    }
    const rows = (await res.json()) as Array<{ display_name?: string; name?: string; lat?: string; lon?: string }>;
    const places: Place[] = rows
      .filter((r) => r.display_name && r.lat && r.lon)
      .map((r) => ({
        label: r.display_name!.slice(0, 160),
        name: (r.name || r.display_name!.split(',')[0]).slice(0, 80),
        lat: Number(r.lat),
        lon: Number(r.lon),
      }));

    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), places });
    return { status: 200, jsonBody: { places, source: 'OpenStreetMap' } };
  } catch (err) {
    ctx.error('places failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('places', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'places',
  handler: placesHandler,
});
