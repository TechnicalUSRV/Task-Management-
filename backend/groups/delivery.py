"""One durable document queue for Group and Task attachments. Network/PDF work is outside the command lock."""
from datetime import timedelta
from io import BytesIO
import time
import uuid

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from core.errors import InputError, fail
from core.services import write_lock
from core.validation import text
from telegram import services as telegram
from telegram.models import TelegramLink
from tasks.filecheck import clean_file_name, content_matches
from . import js
from .models import BoardDelivery, DeliveryPart

MAX_DOCUMENT = 50_000_000  # Public Bot API multipart sendDocument; not changed by frontend validation.
MAX_MERGE = 100_000_000
MAX_PAGES = 1000
MERGED_NAME = 'Combined-documents.pdf'
SEND_INTERVAL = 1.1
ACTIVE = ['QUEUED', 'PREPARING', 'READY', 'APPROVED', 'SENDING']


def pause(seconds):
    time.sleep(seconds)


def linked(actor):
    link = TelegramLink.objects.filter(staff_id=actor).first()
    if not link or not link.chat_id or link.chat_id <= 0 or link.chat_id != link.tg_user_id:
        fail('Connect your Telegram account and open a private chat with the bot first.', 409)
    return link


def validate_files(files, ids, mode, inspect_pdf):
    if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or not all(isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
        fail('Select between 1 and 20 different attachments.')
    if mode not in ('SEPARATE', 'MERGED_PDF'):
        fail('Choose how to send the files.')
    if any(f.size > MAX_DOCUMENT for f in files) and mode == 'SEPARATE':
        fail('Each Telegram document must be under 50 MB.', 413)
    if sum(f.size for f in files) > MAX_MERGE:
        fail('Choose documents totaling at most 100 MB per request.', 413)
    if mode == 'MERGED_PDF':
        if len(files) < 2 or any(f.mime != 'application/pdf' for f in files):
            fail('Choose at least two PDF files to combine.')
        if inspect_pdf and any(not content_matches('pdf', bytes(f.content)) for f in files):
            fail('Choose valid PDF files to combine.')
    return files


def files_for(g, board, actor, ids, mode, inspect_pdf=True):
    validate_files([], ids, 'SEPARATE', False)
    files = [g.file(board, actor, key, metadata_only=True) for key in ids]
    if len({(f.row_id, f.column_id) for f in files}) != 1:
        fail('Select files from one Attachment cell only.')
    return validate_files(files, ids, mode, inspect_pdf)


def task_files(task, actor, ids, mode, inspect_pdf=False):
    from accounts import services as access
    from compat.views import task_file
    access.require_permission(access.account_for(actor), 'tasks.tasks')
    validate_files([], ids, 'SEPARATE', False)
    files = [task_file(actor, key) for key in ids]
    if any(f.task_id != task for f in files):
        fail('Select files from this Task only.', 404)
    return validate_files(files, ids, mode, inspect_pdf)


def merged_name(value, mode):
    if value in (None, ''):
        return ''
    if mode != 'MERGED_PDF':
        fail('A file name can be chosen only when PDFs are combined.')
    import re
    name = re.sub(r'[<>:"|?*]+', '-', clean_file_name(text(value, 'File name', 120, True))).strip()
    name = (name[:-4] if name.lower().endswith('.pdf') else name).strip().strip('.').strip()
    if not name:
        fail('Enter a file name for the combined PDF.')
    return name + '.pdf'


def public(job):
    plan = js.loads(job.plan_json, [])
    return {'id': job.id, 'status': job.status, 'mode': job.mode, 'results': js.loads(job.result_json, []),
            'file_name': job.file_name or '', 'error': job.error, 'plan': plan, 'preview': job.preview,
            'total': len(plan) or (1 if job.mode == 'MERGED_PDF' else len(js.loads(job.file_ids_json, [])))}


def status(g, board, actor, key):
    g.open_board(board, actor)
    job = BoardDelivery.objects.filter(id=key, board_id=board, staff_id=actor).first()
    if not job:
        fail('Delivery not found.', 404)
    job_files(job, inspect_pdf=False)
    return public(job)


def task_status(actor, task, key):
    job = BoardDelivery.objects.filter(id=key, task_id=task, staff_id=actor).first()
    if not job:
        fail('Delivery not found.', 404)
    job_files(job, inspect_pdf=False)
    return public(job)


def enqueue_common(d, actor, files, board=None, task=None):
    if any(k in d for k in ('chat_id', 'recipient_id', 'telegram_user_id')):
        fail('Files can only be delivered to your own linked Telegram account.')
    try:
        key = str(uuid.UUID(str(d.get('request_key'))))
    except (ValueError, TypeError, AttributeError):
        fail('A valid delivery request ID is required.')
    name = merged_name(d.get('file_name'), d.get('mode'))
    preview = d.get('preview') is True
    old = BoardDelivery.objects.filter(staff_id=actor, request_key=key).first()
    if old:
        if (old.board_id != board or old.task_id != task or js.loads(old.file_ids_json, []) != d.get('file_ids') or
                old.mode != d.get('mode') or (old.file_name or '') != name or old.preview != preview):
            fail('This request ID was already used for a different delivery.', 409)
        return {'message': 'Delivery already recorded.', 'delivery': public(old)}
    cfg = telegram.settings()
    if not cfg['enabled'] or not cfg['bot_token']:
        fail('Telegram delivery is unavailable. Ask an administrator to enable the bot.', 409)
    link = linked(actor)
    jobs = BoardDelivery.objects.filter(staff_id=actor)
    if jobs.filter(status__in=ACTIVE).count() >= 3 or jobs.filter(created_at__gt=timezone.now() - timedelta(hours=1)).count() >= 30:
        fail('Too many deliveries. Finish or cancel current deliveries and try later.', 429)
    job = BoardDelivery.objects.create(id=uuid.uuid4().hex, board_id=board, task_id=task, staff_id=actor, request_key=key,
        row_id_snapshot=files[0].row_id if board else '', column_id_snapshot=files[0].column_id if board else '',
        file_ids_json=js.dumps(d['file_ids']), mode=d['mode'], file_name=name, preview=preview,
        telegram_user_id=link.tg_user_id, telegram_linked_at=link.linked_at, created_at=timezone.now(), updated_at=timezone.now())
    return {'message': 'Delivery queued for preparation.' if preview else 'Delivery queued.', 'delivery': public(job)}


def enqueue(g, d, actor):
    b, _ = g.open_board(d.get('group_id'), actor)
    g.gov.require_operational(actor)
    result = enqueue_common(d, actor, files_for(g, b['id'], actor, d.get('file_ids'), d.get('mode'), False), board=b['id'])
    g.record(actor, b, 'Telegram delivery queued', result['delivery']['id'])
    return result


def enqueue_task(service, d, actor):
    task = d.get('task_id')
    result = enqueue_common(d, actor, task_files(task, actor, d.get('file_ids'), d.get('mode')), task=task)
    t = service.task(task)
    service.log(actor, 'task', task, t['workspace_id'], 'Telegram delivery queued', result['delivery']['id'])
    return result


def job_files(job, inspect_pdf=False):
    from .views import service
    g = service()
    g.gov.require_operational(job.staff_id)
    ids = js.loads(job.file_ids_json, [])
    if job.task_id:
        return task_files(job.task_id, job.staff_id, ids, job.mode, inspect_pdf)
    from accounts import services as access
    access.require_permission(access.account_for(job.staff_id), 'tasks.groups')
    return files_for(g, job.board_id, job.staff_id, ids, job.mode, inspect_pdf)


def confirm(data, actor, cancel=False, target='group'):
    job = BoardDelivery.objects.filter(id=data.get('delivery_id'), staff_id=actor).first()
    if not job or (target == 'task') != bool(job.task_id):
        fail('Delivery not found.', 404)
    job_files(job)
    if cancel:
        if job.status not in ('QUEUED', 'READY', 'APPROVED'):
            fail('This delivery is already processing or finished.', 409)
        job.status = 'CANCELLED'
        job.parts.all().delete()
    else:
        if job.status in ('APPROVED', 'SENDING', 'SENT'):
            return {'delivery': public(job), 'message': 'Delivery already confirmed.'}
        if job.status != 'READY':
            fail('Wait for document preparation to finish before confirming.', 409)
        job.status = 'APPROVED'
    job.updated_at = timezone.now()
    job.save(update_fields=['status', 'updated_at'])
    return {'delivery': public(job), 'message': 'Delivery cancelled.' if cancel else 'Delivery confirmed.'}


def pdf_parts(files, name=None):
    """Preserve page order/appearance, remove actions; split by measured bytes, never lossy rasterization."""
    from pypdf import PdfReader, PdfWriter
    readers, pages = [], []
    try:
        for f in files:
            reader = PdfReader(BytesIO(bytes(f.content)))
            if reader.is_encrypted:
                fail('Password-protected PDFs cannot be combined. Send them separately.', 422)
            readers.append(reader)
            pages.extend(reader.pages)
            if len(pages) > MAX_PAGES:
                fail('Combine at most 1,000 pages per delivery.', 413)
        if not pages:
            fail('These PDFs have no pages.', 422)
        def split(start, end):
            writer = PdfWriter()
            try:
                for page in pages[start:end]:
                    copied = writer.add_page(page, excluded_keys=['/AA'])
                    for annotation in copied.get('/Annots', []):
                        obj = annotation.get_object()
                        for key in ('/A', '/AA'):
                            obj.pop(key, None)
                out = BytesIO(); writer.write(out)
                if out.tell() <= MAX_DOCUMENT:
                    return [(start + 1, end, out.getvalue())]
            finally:
                writer.close()
            if end - start == 1:
                fail(f'Page {start + 1} alone exceeds the Telegram 50 MB limit. Send its original separately or optimize that page.', 413)
            middle = (start + end) // 2
            return split(start, middle) + split(middle, end)
        parts = split(0, len(pages))
        base = name or MERGED_NAME
        return [{'name': base if len(parts) == 1 else f'{base[:-4]}-part-{i+1:02d}-of-{len(parts):02d}.pdf',
                 'mime': 'application/pdf', 'content': content, 'pages': [start, end]}
                for i, (start, end, content) in enumerate(parts)]
    except InputError:
        raise
    except Exception:
        fail('A selected PDF could not be read safely. Send the files separately or replace the damaged PDF.', 422)


def merge_pdfs(files, name=None):
    """Compatibility helper for callers needing one document."""
    parts = pdf_parts(files, name)
    if len(parts) != 1:
        fail('The combined PDF exceeds the limit. Use the delivery queue to split it into ordered parts.', 413)
    return parts[0]


def claim():
    now = timezone.now()
    stale = now - timedelta(minutes=10)
    expired = now - timedelta(hours=24)
    # Keep the idle path read-only. This worker wakes every two seconds.
    actionable = BoardDelivery.objects.filter(
        Q(status__in=['QUEUED', 'APPROVED'])
        | Q(status__in=['PREPARING', 'SENDING'], updated_at__lt=stale)
        | Q(status='READY', updated_at__lt=expired)
    ).exists()
    if not actionable:
        return None
    with transaction.atomic():
        write_lock()
        BoardDelivery.objects.filter(status='SENDING', updated_at__lt=stale).update(
            status='UNKNOWN', error='Delivery was interrupted. Check Telegram before sending again.', updated_at=timezone.now())
        BoardDelivery.objects.filter(status='PREPARING', updated_at__lt=stale).update(
            status='FAILED', error='Preparation was interrupted; no files were sent. Prepare a new request.', updated_at=timezone.now())
        BoardDelivery.objects.filter(status__in=['READY', 'QUEUED', 'APPROVED'], updated_at__lt=timezone.now()-timedelta(hours=24)).update(
            status='CANCELLED', error='Preparation expired. Select the files again.', updated_at=timezone.now())
        DeliveryPart.objects.exclude(job__status__in=ACTIVE).delete()
        busy = list(BoardDelivery.objects.filter(status__in=['PREPARING', 'SENDING']).values_list('telegram_user_id', flat=True))
        job = BoardDelivery.objects.filter(status__in=['QUEUED', 'APPROVED']).exclude(telegram_user_id__in=busy).order_by('created_at', 'id').first()
        if not job:
            return None
        job.status = 'PREPARING' if job.status == 'QUEUED' else 'SENDING'
        job.worker_token, job.updated_at = uuid.uuid4().hex, timezone.now()
        job.save(update_fields=['status', 'worker_token', 'updated_at'])
        return job


def heartbeat(job, **updates):
    count = BoardDelivery.objects.filter(id=job.id, worker_token=job.worker_token, status__in=['PREPARING', 'SENDING']).update(
        updated_at=timezone.now(), **updates)
    if not count:
        fail('This worker no longer owns the delivery. Check its status before retrying.', 409)


def process_next(transport=None):
    """Claims are serialized, independent jobs run concurrently. Ambiguous sends are never retried automatically."""
    from telegram.bot import http_transport, TELEGRAM_API, TelegramError
    job = claim()
    if not job:
        return False
    attempted, results = False, js.loads(job.result_json, [])
    try:
        files = job_files(job, inspect_pdf=True)
        if job.status == 'PREPARING':
            if job.mode == 'MERGED_PDF':
                documents = pdf_parts(files, job.file_name)
                plan = []
                for i, doc in enumerate(documents):
                    heartbeat(job)
                    DeliveryPart.objects.create(job=job, position=i, name=doc['name'], content=doc['content'])
                    plan.append({'name': doc['name'], 'size': len(doc['content']), 'pages': doc['pages']})
                del documents
            else:
                plan = [{'name': f.name, 'size': f.size} for f in files]
            job.plan_json = js.dumps(plan)
            heartbeat(job, plan_json=job.plan_json, status='READY' if job.preview else 'SENDING')
            if job.preview:
                return True
            job.status = 'SENDING'
        del files
        plan = js.loads(job.plan_json, [])
        for i, item in enumerate(plan):
            if i:
                pause(SEND_INTERVAL)
            checked = job_files(job)  # refresh permissions on every outbound part
            link = linked(job.staff_id)
            if link.tg_user_id != job.telegram_user_id or link.linked_at != job.telegram_linked_at:
                fail('Your Telegram connection changed. Start a new delivery.', 409)
            cfg = telegram.settings()
            if not cfg['enabled'] or not cfg['bot_token']:
                fail('Telegram delivery was disabled.', 409)
            heartbeat(job)
            if job.mode == 'MERGED_PDF':
                part = DeliveryPart.objects.get(job=job, position=i)
                document = {'name': part.name, 'mime': 'application/pdf', 'content': bytes(part.content)}
            else:
                document = {'name': checked[i].name, 'mime': checked[i].mime, 'content': bytes(checked[i].content)}
            if len(document['content']) > MAX_DOCUMENT:
                fail('This document exceeds the configured Telegram delivery limit.', 413)
            send = transport or http_transport(TELEGRAM_API, cfg['bot_token'])['upload']
            attempted = True
            answer = send('sendDocument', link.chat_id, 'document', document, {})
            # Keep attempted true until the successful send is durably recorded. A DB failure is ambiguous too.
            results.append({'name': document['name'], 'size': len(document['content']), 'status': 'SENT',
                            'message_id': (answer or {}).get('message_id')})
            heartbeat(job, result_json=js.dumps(results))
            attempted = False
            del checked, document
        job.status, job.error = 'SENT', ''
    except InputError as e:
        job.status, job.error = ('PARTIAL' if results else 'FAILED'), e.message[:500]
    except Exception as e:
        definite = isinstance(e, TelegramError) and e.code and 400 <= e.code < 500
        job.status = 'PARTIAL' if definite and results else 'FAILED' if definite or not attempted else 'UNKNOWN'
        job.error = ('Telegram refused the document (possibly busy or blocked). Retry only files not sent.' if definite else
                     'Delivery could not be confirmed. Check your Telegram chat before sending again.' if attempted else
                     'Delivery could not be prepared. Check access and try again.')
    with transaction.atomic():
        write_lock()
        BoardDelivery.objects.filter(id=job.id, worker_token=job.worker_token).update(
            status=job.status, error=job.error, result_json=js.dumps(results), updated_at=timezone.now())
        job.parts.all().delete()
    return True
