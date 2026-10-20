import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android app shell for Lineup.
 *
 * The app loads the live site rather than bundled files, so sign-in (Static
 * Web Apps auth) and /api calls work exactly as they do in a browser, and a
 * web deploy updates the app without a store release. Build a dev app with
 * CAP_SERVER_URL=https://lineup-dev.mahoul.io; it then shows Google test ads.
 */
const config: CapacitorConfig = {
  appId: 'io.mahoul.lineup',
  appName: 'Lineup',
  webDir: 'dist',
  server: {
    url: process.env.CAP_SERVER_URL ?? 'https://lineup.mahoul.io',
    androidScheme: 'https',
    // Sign-in hops through the Entra External ID tenant and back.
    allowNavigation: ['lineup.mahoul.io', 'lineup-dev.mahoul.io', '*.ciamlogin.com'],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
