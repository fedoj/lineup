import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyAppSite } from './lib/appSite';
import TestSiteBanner from './components/TestSiteBanner';
import { startInstallSupport } from './lib/install';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// The Android app switched to the test site by an admin goes straight there.
const leaving = applyAppSite();

// After a new version is published, a page opened before it may ask for a
// screen's file that no longer exists. Reload once to pick up the new version.
const RELOADED_KEY = 'lineup.reloadedForUpdate';
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem(RELOADED_KEY)) return;
  event.preventDefault();
  sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  location.reload();
});
window.setTimeout(() => sessionStorage.removeItem(RELOADED_KEY), 30_000);

// A file dropped outside an upload area must not open in place of the app.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
}

// Install to the home screen and notifications (Fady, 10/19).
if (!leaving) startInstallSupport();

if (!leaving) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <TestSiteBanner />
      <App />
    </React.StrictMode>,
  );
}
