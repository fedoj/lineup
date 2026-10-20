/*
 * Lineup service worker (Fady, 10/19). It makes the app installable and shows
 * push notifications. It does not cache pages or data: the app always talks
 * to the server, so nothing goes stale.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A push from Lineup: { title, body, link }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Lineup', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Lineup', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { link: data.link || '/' },
      tag: data.tag || undefined,
      // A grouped chat notification replaced with a newer count still buzzes.
      renotify: Boolean(data.tag),
    }),
  );
});

// Tapping a notification opens (or focuses) Lineup at its link.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          w.navigate(link).catch(() => undefined);
          return w.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
