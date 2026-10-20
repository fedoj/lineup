import { useState } from 'react';
import { api, type LogoKind } from '../lib/api';
import FilePick from './FilePick';

const FALLBACK: Record<LogoKind, string> = { org: '🏛️', region: '📍', team: '⚽' };

/** A logo when one is set, otherwise the usual icon for that level. */
export function Logo({
  kind,
  id,
  version,
  size = 22,
}: {
  kind: LogoKind;
  id: string;
  version?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (!version || broken) {
    return (
      <span className="logo-fallback" style={{ width: size, height: size, fontSize: size * 0.72 }} aria-hidden>
        {FALLBACK[kind]}
      </span>
    );
  }
  return (
    <img
      className="logo"
      src={api.logoUrl(kind, id, version)}
      width={size}
      height={size}
      alt=""
      onError={() => setBroken(true)}
    />
  );
}

/**
 * Shrink an image to a square logo in the browser, so a 5 MB phone photo
 * becomes a few kilobytes before it is uploaded.
 */
async function toLogoDataUrl(file: File, edge = 192): Promise<string> {
  // Read as a data: URL rather than a blob: URL, which the CSP does not allow.
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('That file is not an image we can read.'));
    el.src = source;
  });
  // Fit (not crop) so a wide crest keeps its edges, on a clear background.
  const scale = Math.min(edge / img.width, edge / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Image resizing is not available in this browser.');
  g.drawImage(img, (edge - w) / 2, (edge - h) / 2, w, h);
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

/** Upload or remove the logo for an organization, region or team. */
export function LogoUpload({
  kind,
  id,
  version,
  onChanged,
}: {
  kind: LogoKind;
  id: string;
  version?: string | null;
  onChanged: (version: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await toLogoDataUrl(file);
      const res = await api.uploadLogo(kind, id, dataUrl);
      onChanged(res.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.removeLogo(kind, id);
      onChanged(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the logo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="logo-upload">
      <FilePick
        accept="image/png,image/jpeg,image/webp"
        busy={busy}
        onFile={(f) => void pick(f)}
        onReject={() => setError('Use a PNG, JPEG or WebP image.')}
        preview={<Logo kind={kind} id={id} version={version} size={40} />}
        chooseLabel={busy ? 'Uploading…' : version ? 'Change logo' : 'Choose image'}
        dropText={version ? 'Drag a new logo here' : 'Drag a logo here'}
        actions={
          version ? (
            <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={remove}>
              Remove
            </button>
          ) : null
        }
      />
      {error && <span className="danger-text">{error}</span>}
    </div>
  );
}
