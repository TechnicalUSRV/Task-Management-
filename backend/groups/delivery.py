"""Queued delivery to the caller's own Telegram. Network work never holds the command lock."""
from datetime import timedelta
from io import BytesIO
import time
import uuid

from django.db import transaction
from django.utils import timezone
from core.errors import InputError, fail
from core.services import write_lock
from telegram import services as telegram
from telegram.models import TelegramLink
from core.validation import text
from tasks.filecheck import clean_file_name, content_matches
from . import js
from .models import BoardDelivery

MAX_DOCUMENT = 50_000_000
MAX_MERGE = 100_000_000
MAX_PAGES = 1000
MERGED_NAME = 'Combined-documents.pdf'
# Telegram asks bots to send about one message per second to one chat; bursts beyond that are refused with 429.
SEND_INTERVAL = 1.1


def pause(seconds):
    time.sleep(seconds)


def linked(actor):
    link = TelegramLink.objects.filter(staff_id=actor).first()
    if not link or not link.chat_id or link.chat_id <= 0 or link.chat_id != link.tg_user_id:
        fail('Connect your Telegram account and open a private chat with the bot first.', 409)
    return link


def files_for(g, board, actor, ids, mode, inspect_pdf=True):
    if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or not all(isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
        fail('Select between 1 and 20 different attachments.')
    files = [g.file(board, actor, key, metadata_only=True) for key in ids]
    if len({(f.row_id, f.column_id) for f in files}) != 1:
        fail('Select files from one Attachment cell only.')
    if mode not in ('SEPARATE', 'MERGED_PDF'):
        fail('Choose how to send the files.')
    if any(f.size > MAX_DOCUMENT for f in files):
        fail('Each Telegram document must be under 50 MB.', 413)
    if mode == 'MERGED_PDF':
        if len(files) < 2 or any(f.mime != 'application/pdf' for f in files):
            fail('Choose at least two PDF files to combine.')
        if sum(f.size for f in files) > MAX_MERGE:
            fail('Choose PDFs totaling at most 100 MB.', 413)
        # Same rule as the upload check, so a PDF accepted into a cell is never refused here.
        if inspect_pdf and any(not content_matches('pdf', bytes(f.content)) for f in files):
            fail('Choose at least two PDF files to combine.')
    return files


def merged_name(value, mode):
    """The file name a person chose for a combined PDF: cleaned like an uploaded file's name, always ending in .pdf."""
    if value in (None, ''):
        return ''
    if mode != 'MERGED_PDF':
        fail('A file name can be chosen only when PDFs are combined.')
    import re
    name = re.sub(r'[<>:"|?*]+', '-', clean_file_name(text(value, 'File name', 120, True))).strip()
    if name.lower().endswith('.pdf'):
        name = name[:-4]
    name = name.strip().strip('.').strip()
    if not name:
        fail('Enter a file name for the combined PDF.')
    return f'{name}.pdf'


def public(job):
    return {'id': job.id, 'status': job.status, 'mode': job.mode, 'results': js.loads(job.result_json, []), 'file_name': job.file_name or '',
            'error': job.error, 'total': 1 if job.mode == 'MERGED_PDF' else len(js.loads(job.file_ids_json, []))}


def status(g, board, actor, key):
    g.open_board(board, actor)
    job = BoardDelivery.objects.filter(id=key, board_id=board, staff_id=actor).first()
    if not job:
        fail('Delivery not found.', 404)
    return public(job)


def enqueue(g, d, actor):
    if any(k in d for k in ('chat_id', 'recipient_id', 'telegram_user_id')):
        fail('Files can only be delivered to your own linked Telegram account.')
    b, _ = g.open_board(d.get('group_id'), actor)
    if not g.gov.active(actor):
        fail('Your account is inactive.', 403)
    try:
        key = str(uuid.UUID(str(d.get('request_key'))))
    except (ValueError, TypeError, AttributeError):
        fail('A valid delivery request ID is required.')
    name = merged_name(d.get('file_name'), d.get('mode'))
    old = BoardDelivery.objects.filter(staff_id=actor, request_key=key).first()
    if old:
        if (old.board_id != b['id'] or js.loads(old.file_ids_json, []) != d.get('file_ids') or old.mode != d.get('mode')
                or (old.file_name or '') != name):
            fail('This request ID was already used for a different delivery.', 409)
        return {'message': 'Delivery already recorded.', 'delivery': public(old)}
    cfg = telegram.settings()
    if not cfg['enabled'] or not cfg['bot_token']:
        fail('Telegram delivery is unavailable. Ask an administrator to enable the bot.', 409)
    link = linked(actor)
    # Metadata only: uploads were content-checked already and the worker re-checks before merging, so a click never
    # loads up to 100 MB of file contents into the web server.
    files = files_for(g, b['id'], actor, d.get('file_ids'), d.get('mode'), inspect_pdf=False)
    jobs = BoardDelivery.objects.filter(staff_id=actor)
    if jobs.filter(status__in=['QUEUED', 'SENDING']).count() >= 3 or jobs.filter(created_at__gt=g.now() - timedelta(hours=1)).count() >= 30:
        fail('Too many deliveries. Wait for current deliveries to finish and try later.', 429)
    job = BoardDelivery.objects.create(id=uuid.uuid4().hex, board_id=b['id'], staff_id=actor, request_key=key,
        row_id_snapshot=files[0].row_id, column_id_snapshot=files[0].column_id, file_ids_json=js.dumps(d['file_ids']), mode=d['mode'], file_name=name,
        telegram_user_id=link.tg_user_id, telegram_linked_at=link.linked_at, created_at=g.now(), updated_at=g.now())
    g.record(actor, b, 'Telegram delivery queued', f"{len(files)} files · {job.mode}{' · ' + name if name else ''} · {job.id}")
    return {'message': 'Delivery queued.', 'delivery': public(job)}


def merge_pdfs(files, name=None):
    from pypdf import PdfReader, PdfWriter
    writer, count = PdfWriter(), 0
    try:
        for f in files:
            reader = PdfReader(BytesIO(bytes(f.content)))
            if reader.is_encrypted:
                fail('Password-protected PDFs cannot be combined. Send them separately.', 422)
            count += len(reader.pages)
            if count > MAX_PAGES:
                fail('Combine at most 1,000 pages per delivery.', 413)
            for page in reader.pages:
                # Keep visual annotations (stamps, highlights, form appearances), but discard page/annotation actions.
                copied = writer.add_page(page, excluded_keys=['/AA'])
                for annotation in copied.get('/Annots', []):
                    annotation = annotation.get_object()
                    for key in ('/A', '/AA'):
                        annotation.pop(key, None)
        if count == 0:
            fail('These PDFs have no pages.', 422)
        with BytesIO() as out:
            writer.write(out)
            if out.tell() > MAX_DOCUMENT:
                fail('The combined PDF exceeds Telegram’s 50 MB limit. Select fewer files.', 413)
            return {'name': name or MERGED_NAME, 'mime': 'application/pdf', 'content': out.getvalue()}
    except InputError:
        raise
    except Exception:
        fail('A selected PDF could not be read safely. Send the files separately or replace the damaged PDF.', 422)
    finally:
        writer.close()


def process_next(transport=None):
    """Claim exactly once. A crash/ambiguous timeout is not retried automatically (Telegram has no deduplication key)."""
    from .views import service
    from telegram.bot import http_transport, TELEGRAM_API, TelegramError
    # Idle check without the shared write lock: this runs every two seconds, and every user command waits for that lock.
    if not BoardDelivery.objects.filter(status__in=['QUEUED', 'SENDING']).exists():
        return False
    with transaction.atomic():
        write_lock()
        BoardDelivery.objects.filter(status='SENDING', updated_at__lt=timezone.now() - timedelta(minutes=10)).update(
            status='UNKNOWN', error='Delivery was interrupted. Check your Telegram chat before sending again.', updated_at=timezone.now())
        job = BoardDelivery.objects.filter(status='QUEUED').order_by('created_at', 'id').first()
        if not job:
            return False
        job.status, job.updated_at = 'SENDING', timezone.now()
        job.save(update_fields=['status', 'updated_at'])
    results, attempted = [], False
    try:
        g = service()
        if not g.gov.active(job.staff_id):
            fail('Your account is inactive.', 403)
        ids = js.loads(job.file_ids_json, [])
        files = files_for(g, job.board_id, job.staff_id, ids, job.mode)
        merged = merge_pdfs(files, job.file_name) if job.mode == 'MERGED_PDF' else None
        del files
        for i in range(1 if merged else len(ids)):
            if i:
                pause(SEND_INTERVAL)
            # Fresh governance and access checks for every outbound document.
            g = service()
            if not g.gov.active(job.staff_id):
                fail('Your account is inactive.', 403)
            checked = files_for(g, job.board_id, job.staff_id, ids if merged else [ids[i]], job.mode, inspect_pdf=False)
            document = merged or {'name': checked[0].name, 'mime': checked[0].mime, 'content': bytes(checked[0].content)}
            link = linked(job.staff_id)
            if link.tg_user_id != job.telegram_user_id or link.linked_at != job.telegram_linked_at:
                fail('Your Telegram connection changed. Start a new delivery.', 409)
            cfg = telegram.settings()
            if not cfg['enabled'] or not cfg['bot_token']:
                fail('Telegram delivery was disabled.', 409)
            send = transport or http_transport(TELEGRAM_API, cfg['bot_token'])['upload']
            attempted = True
            answer = send('sendDocument', link.chat_id, 'document', document, {})
            attempted = False
            results.append({'name': document['name'], 'status': 'SENT', 'message_id': (answer or {}).get('message_id')})
            BoardDelivery.objects.filter(id=job.id).update(result_json=js.dumps(results), updated_at=timezone.now())
            del checked, document
        job.status, job.error = 'SENT', ''
    except InputError as e:
        job.status, job.error = ('PARTIAL' if results else 'FAILED'), e.message[:500]
    except Exception as e:
        definite = isinstance(e, TelegramError) and e.code and 400 <= e.code < 500
        job.status = 'PARTIAL' if definite and results else 'FAILED' if definite or not attempted else 'UNKNOWN'
        job.error = ('Telegram refused the document. Check that the bot is not blocked, then try again.' if definite else
                     'Delivery could not be confirmed. Check your Telegram chat before sending again.' if attempted else
                     'Delivery could not be prepared. Check access and try again.')
    with transaction.atomic():
        write_lock()
        job.result_json, job.updated_at = js.dumps(results), timezone.now()
        job.save(update_fields=['status', 'error', 'result_json', 'updated_at'])
        g = service()
        b = g.board_row(job.board_id)
        if b:
            g.record(job.staff_id, b, 'Telegram delivery ' + job.status.lower(), f'{job.id} · {len(results)} documents sent')
    return True
