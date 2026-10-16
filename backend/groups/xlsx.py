"""Excel workbooks (.xlsx) for Group export and import, with no outside libraries — xlsx.mjs (V5.7.7).

Writing: one worksheet with a bold, frozen header row, filters on the header, sensible column widths, real numbers, real
dates (with a date format) and text that is always text (a value starting with "=" is stored as text, never a formula).
No hidden sheets and no document properties.

Reading: the cell values of each worksheet (shared strings, inline strings, numbers, booleans, errors and the saved
results of formulas, which are never calculated), with dates recognised from the cell's number format. Files that are
not .xlsx packages, are too large or complex, expand far beyond their size (zip bombs) or whose XML declares a DOCTYPE or
entities are refused.
"""
import re
import struct
import zlib
from datetime import date, timedelta

from . import js

READ_LIMITS = {'fileBytes': 5 * 1024 * 1024, 'entries': 2000, 'entryBytes': 40 * 1024 * 1024, 'totalBytes': 80 * 1024 * 1024, 'ratio': 200,
               'sheets': 20, 'rows': 20000, 'columns': 200, 'cells': 400000, 'text': 32767, 'chars': 10000000}


class XlsxError(Exception):
    status = 422


def _refuse(message):
    raise XlsxError(message)


# ------------------------------------------------------------------ zip
_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1


def zip_entries(entries):
    locals_, centrals, offset = [], [], 0
    for name, data in entries:
        raw = data if isinstance(data, bytes) else data.encode('utf-8')
        comp = zlib.compressobj(6, zlib.DEFLATED, -15)
        packed = comp.compress(raw) + comp.flush()
        name_b, crc = name.encode('utf-8'), zlib.crc32(raw) & 0xffffffff
        local = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0x0800, 8, 0, _DOS_DATE, crc, len(packed), len(raw), len(name_b), 0)
        central = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0x0800, 8, 0, _DOS_DATE, crc, len(packed), len(raw),
                              len(name_b), 0, 0, 0, 0, 0, offset)
        locals_ += [local, name_b, packed]
        centrals += [central, name_b]
        offset += len(local) + len(name_b) + len(packed)
    directory = b''.join(centrals)
    end = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(entries), len(entries), len(directory), offset, 0)
    return b''.join(locals_) + directory + end


def unzip(buf, limits=READ_LIMITS):
    """The parts inside a zip, read lazily: (names, read(name) -> bytes|None). Sizes are checked before inflating anything."""
    if not isinstance(buf, (bytes, bytearray)) or len(buf) < 22:
        _refuse('This is not an Excel workbook (.xlsx).')
    if len(buf) > limits['fileBytes']:
        _refuse(f"The file is larger than {round(limits['fileBytes'] / 1048576)} MB.")
    eocd = -1
    for i in range(len(buf) - 22, max(0, len(buf) - 65557) - 1, -1):
        if struct.unpack_from('<I', buf, i)[0] == 0x06054b50:
            eocd = i
            break
    if eocd < 0:
        _refuse('This is not an Excel workbook (.xlsx). Save it as “Excel Workbook (*.xlsx)” and try again.')
    count, size, start = struct.unpack_from('<H', buf, eocd + 10)[0], struct.unpack_from('<I', buf, eocd + 12)[0], struct.unpack_from('<I', buf, eocd + 16)[0]
    if count > limits['entries']:
        _refuse('This workbook has too many parts to be read safely.')
    if start + size > len(buf):
        _refuse('This workbook is damaged (its contents list is cut off).')
    files, total, p = {}, 0, start
    for _ in range(count):
        if p + 46 > len(buf) or struct.unpack_from('<I', buf, p)[0] != 0x02014b50:
            _refuse('This workbook is damaged.')
        flags, method = struct.unpack_from('<HH', buf, p + 8)
        csize, usize = struct.unpack_from('<II', buf, p + 20)
        nlen, xlen, clen = struct.unpack_from('<HHH', buf, p + 28)
        local = struct.unpack_from('<I', buf, p + 42)[0]
        name = bytes(buf[p + 46:p + 46 + nlen]).decode('utf-8', 'replace')
        if flags & 1:
            _refuse('This workbook is password-protected. Remove the password in Excel and try again.')
        if usize > limits['entryBytes'] or (csize > 0 and usize / csize > limits['ratio'] and usize > 1048576):
            _refuse('This workbook expands to far more data than its file size suggests, so it is not read (it may be damaged or unsafe).')
        total += usize
        if total > limits['totalBytes']:
            _refuse('This workbook holds too much data to import at once. Split it into smaller files.')
        files[name] = (method, csize, usize, local)
        p += 46 + nlen + xlen + clen

    def read(name):
        f = files.get(name)
        if not f:
            return None
        method, csize, usize, local = f
        if local + 30 > len(buf) or struct.unpack_from('<I', buf, local)[0] != 0x04034b50:
            _refuse('This workbook is damaged.')
        at = local + 30 + struct.unpack_from('<H', buf, local + 26)[0] + struct.unpack_from('<H', buf, local + 28)[0]
        data = bytes(buf[at:at + csize])
        if method == 0:
            return data
        if method != 8:
            _refuse('This workbook uses a compression Excel does not normally use.')
        try:
            d = zlib.decompressobj(-15)
            out = d.decompress(data, max(usize, 1) + 1024)
        except zlib.error:
            _refuse('This workbook is damaged (a part could not be unpacked).')
        if len(out) != usize:
            _refuse('This workbook is damaged (a part has the wrong size).')
        return out
    return list(files), read


# ------------------------------------------------------------------ XML helpers (no DOCTYPE, no entities, nothing external)
def _esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


_XML_BAD = re.compile('[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]')


def _xml_text(s):
    return _esc(_XML_BAD.sub('', str(s)))


_ENT = {'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'"}


def _unesc(s):
    def entity(m):
        e = m.group(1)
        if e[0] == '#':
            n = int(e[2:], 16) if e[1] == 'x' else int(e[1:], 10)
            return chr(n) if 0 < n < 0x110000 else ''
        return _ENT[e]
    s = re.sub(r'&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);', entity, s)
    return re.sub(r'_x([0-9A-Fa-f]{4})_', lambda m: chr(int(m.group(1), 16)), s)


def _xml_of(data, name):
    s = data.decode('utf-8', 'replace')
    if re.search(r'<!DOCTYPE|<!ENTITY', s, re.IGNORECASE):
        _refuse(f'This workbook contains XML features that are not allowed ({name}). Save it again from Excel as a normal .xlsx file.')
    return s


def _attr(tag, name):
    m = re.search(r'\s' + re.escape(name) + r'="([^"]*)"', tag)
    return _unesc(m.group(1)) if m else None


def _elements(s, tag, start=0, stop=None):
    """Every element <tag …>…</tag> or <tag …/> in order, as (open tag, body). Plain scanning, no regex backtracking."""
    stop = len(s) if stop is None else stop
    opener, i = '<' + tag, start
    while True:
        i = s.find(opener, i)
        if i < 0 or i >= stop:
            return
        c = s[i + len(opener):i + len(opener) + 1]
        if c not in (' ', '>', '/', '\t', '\n', '\r'):
            i += len(opener)
            continue
        gt = s.find('>', i)
        if gt < 0:
            return
        head = s[i:gt + 1]
        if head.endswith('/>'):
            yield head, ''
            i = gt + 1
            continue
        close = s.find('</' + tag + '>', gt)
        if close < 0:
            return
        yield head, s[gt + 1:close]
        i = close + len(tag) + 3


def _text_of(body):
    return ''.join(_unesc(b) for _, b in _elements(body, 't'))


def _col_index(ref):
    n = 0
    for ch in ref:
        c = ord(ch)
        if c < 65 or c > 90:
            break
        n = n * 26 + (c - 64)
    return n - 1


def col_name(i):
    s, i = '', i + 1
    while i > 0:
        m = (i - 1) % 26
        s = chr(65 + m) + s
        i = (i - 1) // 26
    return s


# ------------------------------------------------------------------ dates
_EPOCH = date(1899, 12, 30)


def serial_to_day(n):
    if not js.is_number(n) or n != n or n < 1 or n > 2958465:
        return None
    return (_EPOCH + timedelta(days=int(n // 1))).isoformat()


def day_to_serial(day):
    y, m, d = (int(x) for x in day.split('-'))
    return (date(y, m, d) - _EPOCH).days


_BUILTIN_DATES = {14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57}


def _is_date_format(code):
    plain = re.sub(r'\\.', '', re.sub(r'\[[^\]]*\]', '', re.sub(r'"[^"]*"', '', str(code or ''))))
    return bool(re.search(r'[dmyhs]', plain, re.IGNORECASE)) and not re.match(r'^[#0.,%E+\-\s?/]*$', plain, re.IGNORECASE)


# ------------------------------------------------------------------ writing
def _dec_fmt(d):
    return '#,##0' if d == 0 else '#,##0.' + '0' * d


def write_xlsx(sheets):
    """sheets: [{name, columns: [{header, type: 'text'|'number'|'date'|'bool', decimals}], rows: [[value…]]}] -> bytes."""
    strings, index = [], {}

    def sst(s):
        i = index.get(s)
        if i is None:
            i = len(strings)
            strings.append(s)
            index[s] = i
        return i
    num_fmts = [(164, 'yyyy-mm-dd'), *[(165 + d, _dec_fmt(d)) for d in range(7)]]
    xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
           '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>',
           '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
           '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>',
           *[f'<xf numFmtId="{165 + d}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' for d in range(7)],
           '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>']
    general_number = 4 + 7

    def sheet_xml(sheet):
        cols, rows = sheet['columns'], sheet['rows']
        widths = [min(60, max(8, js.length(str(c['header'])) + 2)) for c in cols]
        out = [f'<row r="1" spans="1:{max(1, len(cols))}">' +
               ''.join(f'<c r="{col_name(i)}1" t="s" s="1"><v>{sst(str(c["header"]))}</v></c>' for i, c in enumerate(cols)) + '</row>']
        for ri, row in enumerate(rows):
            r, cells = ri + 2, []
            for ci, c in enumerate(cols):
                v = row[ci] if ci < len(row) else None
                ref = f'{col_name(ci)}{r}'
                if v is None or v == '' or (isinstance(v, list) and not v):
                    continue
                if isinstance(v, dict) and v.get('error'):
                    cells.append(f'<c r="{ref}" t="e"><v>{_xml_text(v["error"])}</v></c>')
                    widths[ci] = max(widths[ci], len(v['error']) + 2)
                    continue
                if isinstance(v, bool):
                    cells.append(f'<c r="{ref}" t="b"><v>{1 if v else 0}</v></c>')
                    continue
                if c['type'] == 'date' and isinstance(v, str) and re.match(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', v):
                    cells.append(f'<c r="{ref}" s="2"><v>{day_to_serial(v)}</v></c>')
                    widths[ci] = max(widths[ci], 12)
                    continue
                if js.is_number(v) and v == v and v not in (float('inf'), float('-inf')):
                    d = c.get('decimals')
                    d = None if d is None else max(0, min(6, int(d)))
                    shown = js.num_str(v)
                    cells.append(f'<c r="{ref}" s="{general_number if d is None else 4 + d}"><v>{shown}</v></c>')
                    widths[ci] = max(widths[ci], min(24, len(shown) + 4))
                    continue
                s = js.to_js_string(v)[:READ_LIMITS['text']]
                as_text = ' s="3"' if re.match('^[=+\\-@\t\r]', s) else ''
                cells.append(f'<c r="{ref}" t="s"{as_text}><v>{sst(s)}</v></c>')
                longest = max((js.length(line) for line in s.split('\n')), default=0)
                widths[ci] = max(widths[ci], min(60, longest + 2))
            out.append(f'<row r="{r}" spans="1:{max(1, len(cols))}">{"".join(cells)}</row>')
        last = f'{col_name(max(0, len(cols) - 1))}{len(rows) + 1}'
        col_xml = ('<cols>' + ''.join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths)) + '</cols>') if cols else ''
        auto_filter = '<autoFilter ref="A1:' + last + '"/>' if cols else ''
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'<dimension ref="A1:{last}"/><sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                f'<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>{col_xml}'
                f'<sheetData>{"".join(out)}</sheetData>{auto_filter}'
                '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')

    names = []

    def safe_name(n):
        s = js.trim(re.sub(r"^'+|'+$", '', re.sub(r'[\\/?*[\]:]', ' ', str(n or 'Sheet'))))[:31] or 'Sheet'
        k, i = s, 2
        while k.lower() in names:
            k = f'{s[:28]} ({i})'
            i += 1
        names.append(k.lower())
        return k
    titled = [{**s, 'title': safe_name(s['name'])} for s in sheets]
    parts = [(f'xl/worksheets/sheet{i + 1}.xml', sheet_xml(s)) for i, s in enumerate(titled)]
    head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    files = [
        ('[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
         + ''.join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(titled)))
         + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'),
        ('_rels/.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
        ('xl/workbook.xml', head + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>'
         + ''.join(f'<sheet name="{_xml_text(s["title"])}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, s in enumerate(titled)) + '</sheets></workbook>'),
        ('xl/_rels/workbook.xml.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
         + ''.join(f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(titled)))
         + f'<Relationship Id="rId{len(titled) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId{len(titled) + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
        *parts,
    ]
    files.append(('xl/styles.xml', head + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                  f'<numFmts count="{len(num_fmts)}">' + ''.join(f'<numFmt numFmtId="{i}" formatCode="{_esc(code)}"/>' for i, code in num_fmts) + '</numFmts>'
                  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
                  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF9"/><bgColor indexed="64"/></patternFill></fill></fills>'
                  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA6B8"/></bottom><diagonal/></border></borders>'
                  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                  f'<cellXfs count="{len(xfs)}">{"".join(xfs)}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'))
    files.append(('xl/sharedStrings.xml', head + f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">'
                  + ''.join(f'<si><t xml:space="preserve">{_xml_text(s)}</t></si>' for s in strings) + '</sst>'))
    return zip_entries(files)


# ------------------------------------------------------------------ reading
def read_xlsx(buf, limits=READ_LIMITS):
    """Every worksheet: [{name, hidden, rows: [[cell…]], truncated, formulas_without_results, columns}]. A cell is
    {'v': str|number|bool|None, 'date'?: 'YYYY-MM-DD', 'error'?: '#N/A', 'formula'?: True, 'missing'?: True}."""
    names, read = unzip(buf, limits)

    def part(name):
        b = read(name)
        return _xml_of(b, name) if b is not None else None
    book = part('xl/workbook.xml')
    if not book:
        _refuse('This is not an Excel workbook (.xlsx). Save it as “Excel Workbook (*.xlsx)” and try again.')
    rels = {_attr(o, 'Id'): _attr(o, 'Target') for o, _ in _elements(part('xl/_rels/workbook.xml.rels') or '', 'Relationship')}
    strings, sst_xml = [], part('xl/sharedStrings.xml')
    if sst_xml:
        for _, body in _elements(sst_xml, 'si'):
            strings.append(_text_of(body)[:limits['text']])
            if len(strings) > limits['cells']:
                _refuse('This workbook has too much text to import at once.')
    date_styles, styles = set(), part('xl/styles.xml')
    if styles:
        custom = {}
        for o, _ in _elements(styles, 'numFmt'):
            custom[js.number(_attr(o, 'numFmtId'))] = _attr(o, 'formatCode')
        block = next(_elements(styles, 'cellXfs'), None)
        if block:
            for i, (o, _) in enumerate(_elements(block[1], 'xf')):
                fid = js.number(_attr(o, 'numFmtId') or 0)
                if fid in _BUILTIN_DATES or (fid in custom and _is_date_format(custom[fid])):
                    date_styles.add(i)
    sheets, parts, cells, chars = [], set(), 0, 0
    for o, _ in _elements(book, 'sheet'):
        if len(sheets) >= limits['sheets']:
            _refuse(f"This workbook has more than {limits['sheets']} worksheets. Remove the ones you don’t need and try again.")
        name = _attr(o, 'name') or f'Sheet {len(sheets) + 1}'
        state, rid = _attr(o, 'state') or 'visible', _attr(o, 'r:id')
        target = rels.get(rid) or ''
        target = target[1:] if target.startswith('/') else 'xl/' + re.sub(r'^\./', '', target)
        if target and target in parts:
            _refuse('This workbook is damaged (two worksheets share the same data). Save it again from Excel as a normal .xlsx file.')
        if target:
            parts.add(target)
        xml = part(target) if target else None
        sheet = {'name': name, 'hidden': state != 'visible', 'rows': [], 'truncated': False, 'formulas_without_results': 0, 'columns': 0}
        if not xml:
            sheets.append(sheet)
            continue
        data = next(_elements(xml, 'sheetData'), None)
        for ro, rbody in (_elements(data[1], 'row') if data else ()):
            rn = js.number(_attr(ro, 'r'))
            r = max(int(rn) if js.is_number(rn) and rn == rn and float(rn).is_integer() else 0, len(sheet['rows']) + 1)
            if r > limits['rows'] + 1:
                sheet['truncated'] = True
                break
            out = []
            for co, cbody in _elements(rbody, 'c'):
                ref = _attr(co, 'r')
                ci = _col_index(ref) if ref else len(out)
                if ci >= limits['columns']:
                    sheet['truncated'] = True
                    continue
                t = _attr(co, 't') or 'n'
                st_raw = js.number(_attr(co, 's') or 0)
                formula = '<f' in cbody
                v_el = next(_elements(cbody, 'v'), None)
                raw = _unesc(v_el[1]) if v_el else None
                if t == 's':
                    if raw is None:
                        cell = {'v': None}
                    else:
                        k = js.number(raw)
                        cell = {'v': strings[int(k)] if js.is_number(k) and k == k and float(k).is_integer() and 0 <= k < len(strings) else ''}
                elif t == 'inlineStr':
                    cell = {'v': _text_of(cbody)[:limits['text']]}
                elif t == 'str':
                    cell = {'v': raw}
                elif t == 'b':
                    cell = {'v': None if raw is None else raw == '1'}
                elif t == 'e':
                    cell = {'v': None, 'error': raw or '#VALUE!'}
                elif t == 'd':
                    cell = {'v': raw, **({'date': raw[:10]} if raw else {})}
                else:
                    n = None if raw is None or raw == '' else js.number(raw)
                    cell = {'v': js.num(n) if js.is_number(n) and n == n and n not in (float('inf'), float('-inf')) else None}
                    if cell['v'] is not None and st_raw in date_styles:
                        day = serial_to_day(cell['v'])
                        if day:
                            cell['date'] = day
                if formula:
                    cell['formula'] = True
                    if (raw is None or raw == '') and t != 'inlineStr':
                        cell = {'v': None, 'formula': True, 'missing': True}
                        sheet['formulas_without_results'] += 1
                if cell['v'] is None and not cell.get('error') and not cell.get('missing'):
                    continue
                if isinstance(cell['v'], str):
                    chars += js.length(cell['v'])
                    if chars > limits['chars']:
                        _refuse(f"This workbook holds more than {js.locale(limits['chars'])} characters of text, more than a group can hold. Import it in smaller parts.")
                while len(out) < ci:
                    out.append(None)
                if ci < len(out):
                    out[ci] = cell
                else:
                    out.append(cell)
                cells += 1
                if cells > limits['cells']:
                    _refuse(f"This workbook has more than {js.locale(limits['cells'])} filled cells. Import it in smaller parts.")
            while len(sheet['rows']) < r - 1:
                sheet['rows'].append([])
            sheet['rows'].append(out)
            sheet['columns'] = max(sheet['columns'], len(out))
        sheets.append(sheet)
    if not sheets:
        _refuse('This workbook has no worksheets.')
    return sheets
