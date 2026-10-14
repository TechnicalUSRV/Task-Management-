"""An uploaded file must really be the kind its name says (file-check.mjs, V5.6.8): never a program renamed as a document."""


def _starts(b, *values):
    return len(b) >= len(values) and all(b[i] == x for i, x in enumerate(values))


def content_matches(ext, b):
    if (_starts(b, 0x4d, 0x5a) or _starts(b, 0x7f, 0x45, 0x4c, 0x46) or _starts(b, 0xcf, 0xfa, 0xed, 0xfe)
            or _starts(b, 0xfe, 0xed, 0xfa, 0xce) or _starts(b, 0xca, 0xfe, 0xba, 0xbe)):
        return False
    is_zip = _starts(b, 0x50, 0x4b)
    is_ole = _starts(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
    head = b[:16].decode('latin1')
    if ext == 'pdf':
        return '%PDF-' in b[:1024].decode('latin1')
    if ext in ('png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'):
        return (_starts(b, 0x89, 0x50, 0x4e, 0x47) or _starts(b, 0xff, 0xd8, 0xff) or head.startswith('GIF8')
                or (head.startswith('RIFF') and head[8:12] == 'WEBP') or head[4:8] == 'ftyp')
    if ext in ('docx', 'xlsx', 'pptx', 'zip'):
        return is_zip
    if ext in ('doc', 'xls', 'ppt'):
        return is_ole
    return not is_zip and not is_ole


def clean_file_name(name):
    import re
    cleaned = re.sub(r'[\x00-\x1f\x7f]', '', str(name or '').replace('\\', '/').split('/')[-1]).strip()
    return cleaned or 'file'
