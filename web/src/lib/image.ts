/** Downscale an image source to at most `maxWidth` wide and encode as JPEG (quality 0.7) — BUILD_PROMPT 12.2. */
export function toJpegDataUrl(source: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number }, maxWidth = 768, quality = 0.7): string {
  const w0 = source.videoWidth || (source.width as number) || 0;
  const h0 = source.videoHeight || (source.height as number) || 0;
  if (!w0 || !h0) throw new Error('image has no size');
  const scale = Math.min(1, maxWidth / w0);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale);
  canvas.height = Math.round(h0 * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });
}
