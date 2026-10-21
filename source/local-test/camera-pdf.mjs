/** Minimal image-only PDF writer: JPEG bytes stay intact, one ordered image per page. */
export function photoPdf(photos) {
  if (!photos.length || photos.length > 20) throw new Error('Choose 1–20 photos.');
  const enc = new TextEncoder(), chunks = [], offsets = [0]; let size = 0;
  const add = v => { const b = typeof v === 'string' ? enc.encode(v) : v; chunks.push(b); size += b.length; };
  const object = (id, body, data) => { offsets[id] = size; add(`${id} 0 obj\n${body}`); if (data) { add('\nstream\n'); add(data); add('\nendstream'); } add('\nendobj\n'); };
  add('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${photos.length} /Kids [${photos.map((_, i) => `${3+i*3} 0 R`).join(' ')}] >>`);
  photos.forEach((p, i) => {
    if (!Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0) throw new Error('Invalid photo size.');
    const id = 3+i*3, w = 595.28, h = 841.89, scale = Math.min((w-40)/p.width, (h-40)/p.height);
    const iw = p.width*scale, ih = p.height*scale;
    const paint = enc.encode(`q ${iw.toFixed(3)} 0 0 ${ih.toFixed(3)} ${((w-iw)/2).toFixed(3)} ${((h-ih)/2).toFixed(3)} cm /Photo Do Q`);
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Photo ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
    object(id+1, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`, p.bytes);
    object(id+2, `<< /Length ${paint.length} >>`, paint);
  });
  const start = size, count = photos.length*3+3;
  add(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i=1;i<count;i++) add(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  return new Blob(chunks, {type:'application/pdf'});
}
