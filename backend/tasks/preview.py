"""Readable in-app previews of attachments that browsers cannot show by themselves.

Images and PDFs are shown from the file itself (inline=1 on the same authorized download URL; PDFs are drawn by PDF.js
in the browser). For text, CSV, Excel (.xlsx), Word (.docx) and PowerPoint (.pptx) files the server extracts the
content into plain structured data — text, headings, lists, tables and slides — which the screens render as text. No
HTML, script, macro or embedded object from the file ever reaches the browser, and files are never sent to an outside
viewer service. Workbooks and documents are read with the same safe reader as Group imports (groups.xlsx): password-
protected files, zip bombs, oversized parts and XML with DOCTYPE or entity declarations are refused.

Legacy binary formats (.doc, .xls), ZIP archives and anything that cannot be read are answered with kind
'unsupported', so the screens offer a download instead.
"""
import csv
import io
import re
import xml.etree.ElementTree as ET

LIMITS = {'fileBytes': 30 * 1024 * 1024, 'entries': 4000, 'entryBytes': 60 * 1024 * 1024, 'totalBytes': 120 * 1024 * 1024, 'ratio': 200,
          'sheets': 20, 'rows': 20000, 'columns': 200, 'cells': 400000, 'text': 32767, 'chars': 10000000}
MAX_TEXT = 200000          # characters of a text file shown
MAX_ROWS = 500             # rows of each sheet or CSV shown
MAX_COLUMNS = 50           # columns of each sheet or CSV shown
MAX_CELL = 500             # characters of one cell shown
MAX_BLOCKS = 3000          # paragraphs, headings and tables of a document shown
MAX_SLIDES = 200
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
# What the browser shows from the file itself (the screens use PDF.js for PDFs; HEIC shows where the browser can).
INLINE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'application/pdf']


class Unreadable(Exception):
    pass


def kind_of(mime):
    if mime in INLINE_TYPES:
        return 'pdf' if mime == 'application/pdf' else 'image'
    if mime in ('text/plain', 'text/csv', XLSX, DOCX, PPTX):
        return 'data'
    return 'unsupported'


def build(name, mime, content):
    """The preview of one file: {'kind': 'text'|'table'|'document'|'slides'|'unsupported', …}."""
    try:
        if mime == 'text/plain':
            return _text(content)
        if mime == 'text/csv':
            return _csv(content, name)
        if mime == XLSX:
            return _xlsx(content)
        if mime == DOCX:
            return _docx(content)
        if mime == PPTX:
            return _pptx(content)
    except Unreadable as e:
        return {'kind': 'unsupported', 'reason': str(e)}
    except Exception as e:  # noqa: BLE001 — a damaged file is offered as a download, never an error page
        from groups.xlsx import XlsxError
        if isinstance(e, XlsxError):
            return {'kind': 'unsupported', 'reason': str(e)}
        if isinstance(e, (ET.ParseError, ValueError, KeyError, IndexError, UnicodeError)):
            return {'kind': 'unsupported', 'reason': 'This file could not be read. Download it to open it.'}
        raise
    return {'kind': 'unsupported', 'reason': 'This type of file can’t be previewed here. Download it to open it.'}


def _decode(content):
    for encoding in ('utf-8-sig', 'utf-16') if content[:2] in (b'\xff\xfe', b'\xfe\xff') else ('utf-8-sig',):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode('cp1252', errors='replace')


def _clip(value, n=MAX_CELL):
    s = '' if value is None else str(value)
    return s if len(s) <= n else s[:n] + '…'


def _text(content):
    text = _decode(content).replace('\r\n', '\n').replace('\r', '\n')
    return {'kind': 'text', 'text': text[:MAX_TEXT], 'truncated': len(text) > MAX_TEXT}


def _csv(content, name):
    text = _decode(content)
    first = text.split('\n', 1)[0]
    delimiter = max((',', ';', '\t'), key=first.count)
    rows, truncated, columns = [], False, 0
    for i, r in enumerate(csv.reader(io.StringIO(text), delimiter=delimiter)):
        if i >= MAX_ROWS:
            truncated = True
            break
        columns = max(columns, len(r))
        if len(r) > MAX_COLUMNS:
            truncated = True
        rows.append([_clip(c) for c in r[:MAX_COLUMNS]])
    return {'kind': 'table', 'sheets': [{'name': re.sub(r'\.csv$', '', name, flags=re.IGNORECASE) or 'Sheet', 'rows': rows,
                                         'columns': min(columns, MAX_COLUMNS), 'truncated': truncated}]}


def _xlsx(content):
    from groups.imports import cell_display
    from groups.xlsx import read_xlsx
    sheets = []
    for s in read_xlsx(content, LIMITS):
        if s['hidden']:
            continue
        rows = [[_clip(cell_display(c)) for c in r[:MAX_COLUMNS]] for r in s['rows'][:MAX_ROWS]]
        sheets.append({'name': s['name'], 'rows': rows, 'columns': min(s['columns'], MAX_COLUMNS),
                       'truncated': s['truncated'] or len(s['rows']) > MAX_ROWS or s['columns'] > MAX_COLUMNS})
    if not sheets:
        raise Unreadable('This workbook has no visible worksheets. Download it to open it.')
    return {'kind': 'table', 'sheets': sheets}


def _part(content, name):
    from groups.xlsx import _xml_of, unzip
    names, read = unzip(content, LIMITS)
    data = read(name)
    if data is None:
        return None, names, read
    return ET.fromstring(_xml_of(data, name)), names, read


def _xml(read, name):
    from groups.xlsx import _xml_of
    data = read(name)
    return ET.fromstring(_xml_of(data, name)) if data is not None else None


def _runs(p):
    """The text of a Word paragraph as runs [{t, b?, i?}] (deleted text and field codes are left out)."""
    out = []
    for r in p.iter(W + 'r'):
        props = r.find(W + 'rPr')

        def on(tag):
            e = props.find(W + tag) if props is not None else None
            return e is not None and e.get(W + 'val') not in ('0', 'false')
        text = ''
        for child in r:
            if child.tag == W + 't':
                text += child.text or ''
            elif child.tag == W + 'tab':
                text += '\t'
            elif child.tag in (W + 'br', W + 'cr'):
                text += '\n'
        if text:
            run = {'t': text}
            if on('b'):
                run['b'] = 1
            if on('i'):
                run['i'] = 1
            if out and {k: v for k, v in out[-1].items() if k != 't'} == {k: v for k, v in run.items() if k != 't'}:
                out[-1]['t'] += text
            else:
                out.append(run)
    return out


def _paragraph(p):
    props = p.find(W + 'pPr')
    style = props.find(W + 'pStyle') if props is not None else None
    style = (style.get(W + 'val') or '') if style is not None else ''
    runs = _runs(p)
    m = re.match(r'^(?:heading|Heading)\s*([1-9])$', style)
    if style in ('Title', 'title'):
        return {'type': 'heading', 'level': 1, 'runs': runs}
    if m:
        return {'type': 'heading', 'level': min(4, int(m.group(1))), 'runs': runs}
    if props is not None and props.find(W + 'numPr') is not None:
        level = props.find(W + 'numPr').find(W + 'ilvl')
        return {'type': 'item', 'level': int(level.get(W + 'val') or 0) if level is not None else 0, 'runs': runs}
    return {'type': 'paragraph', 'runs': runs}


def _cell_text(tc):
    return '\n'.join(''.join(r['t'] for r in _runs(p)) for p in tc.iter(W + 'p')).strip()


def _docx(content):
    root, _, _ = _part(content, 'word/document.xml')
    if root is None:
        raise Unreadable('This is not a Word document (.docx). Download it to open it.')
    body = root.find(W + 'body')
    blocks, chars, truncated = [], 0, False

    def walk(parent):
        nonlocal chars, truncated
        for el in parent:
            if len(blocks) >= MAX_BLOCKS or chars > MAX_TEXT:
                truncated = True
                return
            if el.tag == W + 'p':
                block = _paragraph(el)
                chars += sum(len(r['t']) for r in block['runs'])
                if block['runs'] or block['type'] == 'paragraph':
                    blocks.append(block)
            elif el.tag == W + 'tbl':
                rows = [[_clip(_cell_text(tc), 2000) for tc in tr.findall(W + 'tc')][:MAX_COLUMNS] for tr in el.findall(W + 'tr')][:MAX_ROWS]
                chars += sum(len(c) for r in rows for c in r)
                blocks.append({'type': 'table', 'rows': rows})
            elif el.tag == W + 'sdt':
                inner = el.find(W + 'sdtContent')
                if inner is not None:
                    walk(inner)
    if body is not None:
        walk(body)
    # Empty paragraphs only make spacing; keep one between blocks at most.
    tidy = []
    for b in blocks:
        if b['type'] == 'paragraph' and not b['runs'] and (not tidy or (tidy[-1]['type'] == 'paragraph' and not tidy[-1]['runs'])):
            continue
        tidy.append(b)
    while tidy and tidy[-1]['type'] == 'paragraph' and not tidy[-1]['runs']:
        tidy.pop()
    return {'kind': 'document', 'blocks': tidy, 'truncated': truncated}


def _pptx(content):
    root, _, read = _part(content, 'ppt/presentation.xml')
    if root is None:
        raise Unreadable('This is not a PowerPoint presentation (.pptx). Download it to open it.')
    rels = _xml(read, 'ppt/_rels/presentation.xml.rels')
    targets = {}
    if rels is not None:
        for rel in rels:
            targets[rel.get('Id')] = rel.get('Target') or ''
    slides, ids = [], root.find(P + 'sldIdLst')
    for n, sld in enumerate(list(ids) if ids is not None else [], start=1):
        if len(slides) >= MAX_SLIDES:
            break
        target = targets.get(sld.get(R + 'id'), '')
        path = target.lstrip('/') if target.startswith('/') else 'ppt/' + re.sub(r'^\./', '', target)
        xml = _xml(read, path) if target else None
        if xml is None:
            continue
        title, paragraphs = '', []
        for sp in xml.iter(P + 'sp'):
            ph = sp.find(f'{P}nvSpPr/{P}nvPr/{P}ph')
            is_title = ph is not None and ph.get('type') in ('title', 'ctrTitle')
            for p in sp.iter(A + 'p'):
                line = ''.join(t.text or '' for t in p.iter(A + 't')).strip()
                if not line:
                    continue
                if is_title and not title:
                    title = _clip(line, 300)
                else:
                    paragraphs.append(_clip(line, 2000))
        for tbl in xml.iter(A + 'tbl'):
            for tr in tbl.iter(A + 'tr'):
                cells = [''.join(t.text or '' for t in tc.iter(A + 't')).strip() for tc in tr.iter(A + 'tc')]
                if any(cells):
                    paragraphs.append(_clip(' | '.join(cells), 2000))
        slides.append({'number': n, 'title': title, 'paragraphs': paragraphs[:200]})
    if not slides:
        raise Unreadable('This presentation has no slides to show. Download it to open it.')
    return {'kind': 'slides', 'slides': slides, 'truncated': (len(ids) if ids is not None else 0) > MAX_SLIDES}


def describe(name, mime, size, content):
    """The JSON a preview endpoint answers: the file's name, type and size and, for data files, their content."""
    out = {'name': name, 'mime': mime, 'size': size, 'view': kind_of(mime)}
    if out['view'] == 'data':
        out.update(build(name, mime, content))
    return out
