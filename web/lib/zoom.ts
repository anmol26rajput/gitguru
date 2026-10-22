// Pure maths for the zoomable diagram viewer (components/Diagram.tsx).
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.25;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

// One button press: dir +1 zooms in, -1 zooms out.
export function stepZoom(z: number, dir: 1 | -1): number {
  return clampZoom(dir > 0 ? z * ZOOM_STEP : z / ZOOM_STEP);
}

// Fit the diagram's natural width into the container. Never enlarges past 100% so a tiny diagram stays tiny.
export function fitZoom(containerWidth: number, naturalWidth: number): number {
  if (!(containerWidth > 0) || !(naturalWidth > 0)) return 1;
  return clampZoom(Math.min(1, containerWidth / naturalWidth));
}

// Ctrl/⌘+wheel and trackpad pinch (ctrl+wheel): smooth. A full mouse notch (|dy| >= 50) equals one button step.
export function wheelZoom(z: number, deltaY: number): number {
  const dy = Math.min(50, Math.max(-50, deltaY));
  return clampZoom(z * Math.exp((-dy / 50) * Math.log(ZOOM_STEP)));
}

// After resizing by `ratio`, how far to scroll so the diagram point under `pointer` stays put.
// `oldOrigin`/`newOrigin` are the diagram's left (or top) edge in the same coordinates as `pointer`, before and after resizing.
export function scrollShift(pointer: number, oldOrigin: number, newOrigin: number, ratio: number): number {
  const wantedOrigin = pointer - (pointer - oldOrigin) * ratio;
  return newOrigin - wantedOrigin;
}
