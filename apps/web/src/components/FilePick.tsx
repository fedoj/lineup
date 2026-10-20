import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { isNativeApp } from '../lib/native';

/**
 * Picking a photo, logo or flyer the way the device expects:
 * - Phones, tablets and the Android app get two buttons: take a photo with
 *   the camera, or choose one from the library.
 * - Computers get a drop area: drag a file onto it, or choose one.
 * Dropping works everywhere it is supported; the camera button only shows
 * where there is a camera to use.
 */

/** A touch device or the Android app, where the camera is the natural source. */
export function prefersCamera(): boolean {
  if (typeof window === 'undefined') return false;
  if (isNativeApp()) return true;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/** Whether a file matches an input's accept list (types, type/* or .ext). */
export function acceptsFile(accept: string, file: File): boolean {
  const types = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (types.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return types.some((t) =>
    t.startsWith('.') ? name.endsWith(t) : t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t,
  );
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Drag-and-drop of a file onto an element: spread dropProps on it. With
 * `onFiles`, every file dropped at once is passed together (rejected ones
 * go to onReject); otherwise only the first goes to onFile.
 */
export function useFileDrop(
  onFile: (file: File) => void,
  {
    accept,
    disabled = false,
    onReject,
    onFiles,
  }: { accept: string; disabled?: boolean; onReject?: (file: File) => void; onFiles?: (files: File[]) => void },
) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child; count them so the highlight stays steady.
  const depth = useRef(0);
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      if (onFiles) {
        const all = Array.from(e.dataTransfer.files ?? []);
        const ok = all.filter((f) => acceptsFile(accept, f));
        all.filter((f) => !ok.includes(f)).forEach((f) => onReject?.(f));
        if (ok.length) onFiles(ok);
        return;
      }
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (!acceptsFile(accept, file)) {
        onReject?.(file);
        return;
      }
      onFile(file);
    },
  };
  return { dragging, dropProps };
}

export function CameraIcon() {
  return (
    <svg className="fp-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3 6.5h2.6l1.4-2h6l1.4 2H17a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1Z" />
      <circle cx="10" cy="11" r="3" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg className="fp-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <circle cx="7" cy="8" r="1.5" />
      <path d="m3 14.5 4.5-4.5 3 3 2-2 4.5 4.5" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="fp-icon fp-icon-lg" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 13V3.5M6 7.5l4-4 4 4" />
      <path d="M3.5 12.5v2a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

/** Two hidden inputs (library, camera) and the buttons or drop area that open them. */
export default function FilePick({
  accept,
  onFile,
  onReject,
  busy = false,
  chooseLabel,
  cameraLabel = 'Take photo',
  camera = true,
  dropText,
  hint,
  preview,
  actions,
}: {
  accept: string;
  onFile: (file: File) => void;
  onReject?: (file: File) => void;
  busy?: boolean;
  /** The library button, e.g. "Choose image". */
  chooseLabel: string;
  cameraLabel?: string;
  /** Offer the camera on phones (images only). */
  camera?: boolean;
  /** On computers, the line in the drop area, e.g. "Drag a logo here". */
  dropText: string;
  hint?: string;
  preview?: ReactNode;
  /** Extra buttons beside the pickers (Remove). */
  actions?: ReactNode;
}) {
  const touch = useMemo(prefersCamera, []);
  const library = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);
  const { dragging, dropProps } = useFileDrop(onFile, { accept, disabled: busy, onReject });

  const taken = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!acceptsFile(accept, file) && !file.type.startsWith('image/')) {
      onReject?.(file);
      return;
    }
    onFile(file);
  };

  return (
    <div className={`file-pick ${touch ? 'touch' : 'desk'}${dragging ? ' over' : ''}${busy ? ' busy' : ''}`} {...dropProps}>
      {preview && <div className="fp-preview">{preview}</div>}
      <div className="fp-body">
        {!touch && (
          <span className="fp-text">
            <UploadIcon />
            {dragging ? 'Drop it here' : `${dropText}, or`}
          </span>
        )}
        <div className="fp-buttons">
          {touch && camera && (
            <button type="button" className="btn btn-sm fp-btn" disabled={busy} onClick={() => cam.current?.click()}>
              <CameraIcon />
              {cameraLabel}
            </button>
          )}
          <button type="button" className="btn ghost btn-sm fp-btn" disabled={busy} onClick={() => library.current?.click()}>
            {touch && <ImageIcon />}
            {chooseLabel}
          </button>
          {actions}
        </div>
        {hint && <span className="fp-hint">{hint}</span>}
      </div>
      <input ref={library} type="file" accept={accept} hidden onChange={taken} />
      {touch && camera && <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={taken} />}
    </div>
  );
}
