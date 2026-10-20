/**
 * Share a file the app made on the spot (Fady, 10/19): a picture of a lineup
 * or stats, or a calendar file. Nothing is uploaded or kept: the phone's share
 * sheet gets the file when it can take one, otherwise it downloads.
 */

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function shareFile(blob: Blob, filename: string, title: string, preferDownload = false): Promise<ShareOutcome> {
  const file = new File([blob], filename, { type: blob.type });
  if (!preferDownload && typeof navigator !== 'undefined' && navigator.canShare && navigator.share) {
    let can = false;
    try {
      can = navigator.canShare({ files: [file] });
    } catch {
      can = false;
    }
    if (can) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      }
    }
  }
  download(blob, filename);
  return 'downloaded';
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture'))), 'image/png'),
  );
}

export function fileSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lineup';
}
