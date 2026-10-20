import { isNativeApp } from '../lib/native';
import { onTestSite, switchAppToLiveSite } from '../lib/appSite';

/** Inside the Android app on the test site: say so, with the way back to the live site. */
export default function TestSiteBanner() {
  if (!isNativeApp() || !onTestSite()) return null;
  return (
    <div className="test-site-banner" role="status">
      <span>🧪 Test site (lineup-dev)</span>
      <button type="button" className="linkish" onClick={switchAppToLiveSite}>
        Back to the live site
      </button>
    </div>
  );
}
