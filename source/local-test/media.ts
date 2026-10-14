// Files and photos in the browser (ERP and Telegram Mini App): read a file as base64, and turn a photo into a
// small square JPEG for a profile. No React or UI here, so both apps can share it.
const toBase64 = (buf: ArrayBuffer) => { const bytes = new Uint8Array(buf); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
/** A file's content as base64 (for attaching files to tasks). */
export async function fileToBase64(file: File): Promise<string> { return toBase64(await file.arrayBuffer()); }

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close?: () => void }> {
  if ('createImageBitmap' in window) {
    try { const bitmap = await createImageBitmap(file); return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }; } catch { /* fall back to an image element */ }
  }
  // A data: address (allowed by the page's security policy) for browsers without createImageBitmap support for this file.
  const url = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('This photo could not be read.')); r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('This photo could not be read. Try a JPEG or PNG photo.')); i.src = url; });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight };
}
/** Crops a photo to a centred square and returns a small JPEG (320 × 320) as base64, ready to save as a profile photo. */
export async function photoFromFile(file: File, size = 320): Promise<string> {
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) throw new Error('Choose a photo (JPEG, PNG or WebP).');
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
  const image = await decodeImage(file);
  try {
    const side = Math.min(image.width, image.height);
    if (!side) throw new Error('This photo could not be read.');
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('This browser cannot prepare photos.');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image.source, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error('This photo could not be prepared.');
    return toBase64(await blob.arrayBuffer());
  } finally { image.close?.(); }
}

