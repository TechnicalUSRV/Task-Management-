// Presentation of authorized report values. Values entered by employees remain verbatim.
export const formatted = (row, key, currency) => key === 'amount_cents'
  ? (row[key] === null ? '-' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(row[key] / 100))
  : key === 'minutes' ? (row[key] === null ? '-' : `${Math.floor(row[key] / 60)}:${String(row[key] % 60).padStart(2, '0')}`)
  : String(row[key] ?? '');
export function filterDescription(r, t = x => x) {
  return Object.entries(r.filters).filter(([k,v]) => k !== 'fields' && k !== 'sources' && (Array.isArray(v) ? v.length : !!v))
    .map(([k,v]) => `${t(k)}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ') || t('All dates and values in the selected sources');
}
const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

/** Same readable font and labels as the screen; values are escaped and never translated. */
export function reportPrintHTML(r, t = (source, params = {}) => source.replace(/\{(p\d+)\}/g,(m,k) => Object.hasOwn(params,k) ? String(params[k]) : m), locale = 'en') {
  const lang = ['en', 'km', 'zh-CN'].includes(locale) ? locale : 'en';
  const fontStyle = typeof document === 'undefined' ? '' : [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map(node => node.href).filter(href => /\/assets\/languages-[^/]+\.css$/.test(href))
    .map(href => `<link rel="stylesheet" href="${escape(href)}">`).join('');
  const sources = r.sections.map(s => `<h2>${escape(s.title)}</h2><p>${escape(t('{p0} records | Date: {p1}', {p0:s.rows.length,p1:s.dateLabel}))}${s.total_cents !== null ? ' | ' + escape(t('Amount:')) + ' ' + escape(formatted({amount_cents:s.total_cents},'amount_cents',r.currency)) : ''}</p><table><thead><tr>${r.columns.map(([,label]) => `<th>${escape(label)}</th>`).join('')}</tr></thead><tbody>${s.rows.map(row => `<tr>${r.columns.map(([key]) => `<td>${escape(formatted(row,key,r.currency))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>${escape(r.title)}</title>${fontStyle}<style>body{font:11px "Noto Sans Khmer Variable","Noto Sans SC Variable",Arial,sans-serif;line-height:${lang === 'en' ? 1.5 : 1.8};color:#24364a;margin:25px}h1{font-size:22px}h2{font-size:16px;margin-top:26px}p{line-height:1.6}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th,td{text-align:left;padding:7px;border-bottom:1px solid #dde4ef;overflow-wrap:anywhere;vertical-align:top}th{background:#eaf0f7}tr{break-inside:avoid}@page{size:landscape;margin:12mm}@media print{.help{display:none}}</style><p class="help">${escape(t("Use your browser's Print command and select Save as PDF for selectable text."))}</p><h1>${escape(r.company)} - ${escape(r.title)}</h1><p>${escape(t('{p0} records | Generated {p1} | {p2}', {p0:r.rows.length,p1:r.generated_at,p2:r.currency}))}</p><p>${escape(t('Filters:'))} ${escape(filterDescription(r,t))}</p>${sources}<p>${escape(t('Amounts are totaled per source, not across lifecycle stages.'))}</p></html>`;
}
