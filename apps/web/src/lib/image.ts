/**
 * Pictures are shrunk on the phone before they are uploaded, so they arrive
 * small and load quickly for everyone. Files are read as data: URLs because
 * the site's content policy allows data: images, not blob:.
 */

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

/** Bytes a base64 data: URL carries. */
export function dataUrlBytes(url: string): number {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

/**
 * A photo as a JPEG no bigger than `maxBytes`: at most `maxSide` pixels on its
 * longest side, then a little lower quality, then a little smaller, until it
 * fits. A transparent PNG gets a white background (it would turn black).
 */
export async function shrinkPhoto(file: File, opts: { maxSide: number; maxBytes: number }): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    readAsDataUrl(file)
      .then((src) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('That picture could not be opened. Try a JPEG or PNG.'));
        i.src = src;
      })
      .catch(reject);
  });
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  let side = Math.min(opts.maxSide, longest);
  const minSide = Math.min(480, side);
  for (;;) {
    const scale = side / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Could not prepare the picture.');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.75, 0.65, 0.55]) {
      const out = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(out) <= opts.maxBytes) return out;
    }
    if (side <= minSide) throw new Error('That picture is too large. Try a smaller one.');
    side = Math.max(minSide, Math.round(side * 0.8));
  }
}
