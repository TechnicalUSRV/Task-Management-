"""Prepared Group/Task delivery, real PDF bytes and safe failure recovery (no external network)."""
import json
import uuid
from datetime import timedelta
from io import BytesIO
from types import SimpleNamespace
import pytest
from django.utils import timezone
from pypdf import PdfReader
from groups import delivery as service
from groups.models import BoardDelivery, DeliveryPart
from telegram.bot import TelegramError
from core.errors import InputError
from tests.test_group_enhancements import files, team, ok, delivery, pdf, connect  # noqa: F401
from tests.test_management_scope import org  # noqa: F401
from tests.test_privacy_review import create, share
from tests.test_groups_and_previews import b64

pytestmark = pytest.mark.django_db(transaction=True)


def test_review_confirm_cancel_and_known_partial_retry(files, monkeypatch):
    _,_,c,g,_,_,ids=files
    monkeypatch.setattr(service,'pause',lambda _:None)
    job=ok(delivery(c['dara'],g,ids,'MERGED_PDF',preview=True))['result']['delivery']
    assert service.process_next(lambda *a:pytest.fail('Preparation must not send'))
    current=BoardDelivery.objects.get(id=job['id']); assert current.status=='READY'
    plan=json.loads(current.plan_json); part=current.parts.get(position=0)
    assert plan[0]['size']==len(part.content)
    assert [float(p.mediabox.width) for p in PdfReader(BytesIO(part.content)).pages]==[100,110,120]
    ok(c['dara'].command('tm.group.delivery.confirm',{'delivery_id':job['id']}))
    sent=[];service.process_next(lambda *a:sent.append(a[3]) or {'message_id':7})
    assert len(sent)==1 and not DeliveryPart.objects.exists()
    job=ok(delivery(c['dara'],g,ids,preview=True))['result']['delivery']
    service.process_next(lambda *a:pytest.fail('Prepare only'))
    ok(c['dara'].command('tm.group.delivery.confirm',{'delivery_id':job['id']}))
    def partial(*a):
        if a[3]['name']=='Second.pdf':raise TelegramError('Busy',429,retry_after=2)
        return {'message_id':8}
    service.process_next(partial)
    current=BoardDelivery.objects.get(id=job['id']); assert current.status=='PARTIAL'
    assert c['dara'].command('tm.group.delivery.retry',{'delivery_id':job['id']}).status_code==409
    BoardDelivery.objects.filter(id=job['id']).update(retry_at=timezone.now()-timedelta(seconds=1))
    ok(c['dara'].command('tm.group.delivery.retry',{'delivery_id':job['id']}))
    remaining=[];service.process_next(lambda *a:remaining.append(a[3]['name']) or {'message_id':9})
    assert remaining==['Second.pdf']
    assert len(json.loads(BoardDelivery.objects.get(id=job['id']).result_json))==2


def test_ambiguous_send_cannot_be_retried(files):
    _,_,c,g,_,_,ids=files
    job=ok(delivery(c['dara'],g,ids,preview=False))['result']['delivery']
    def ambiguous(*a):raise TimeoutError('response lost')
    service.process_next(ambiguous)
    assert BoardDelivery.objects.get(id=job['id']).status=='UNKNOWN'
    assert c['dara'].command('tm.group.delivery.retry',{'delivery_id':job['id']}).status_code==409
    assert not service.process_next(lambda *a:pytest.fail('No duplicate'))


def test_claims_are_bounded_and_exclusive_per_chat(files, monkeypatch):
    from core import document_capacity
    _,_,c,g,_,_,ids=files
    monkeypatch.setattr(document_capacity,'capacity',lambda:{'workers':2})
    keys=[ok(delivery(c['dara'],g,ids))['result']['delivery']['id'] for _ in range(3)]
    BoardDelivery.objects.filter(id=keys[2]).update(telegram_user_id=999)
    one=service.claim(rate_limit=False);two=service.claim(rate_limit=False)
    assert one.id==keys[0] and two.id==keys[2]
    assert service.claim(rate_limit=False) is None
    BoardDelivery.objects.filter(id=one.id).update(updated_at=timezone.now()-timedelta(minutes=11))
    service.claim(rate_limit=False)
    with pytest.raises(InputError):service.heartbeat(one)
    assert BoardDelivery.objects.get(id=one.id).worker_token==''


def test_split_pdf_measures_parts_and_preserves_order(monkeypatch):
    documents=[SimpleNamespace(content=pdf([100+i for i in range(7)])),SimpleNamespace(content=pdf([200+i for i in range(7)]))]
    originals=[d.content for d in documents]
    monkeypatch.setattr(service,'MAX_DOCUMENT',850)
    parts=service.pdf_parts(documents,'Business.pdf')
    assert len(parts)>1 and all(len(p['content'])<=850 for p in parts)
    widths=[int(p.mediabox.width) for part in parts for p in PdfReader(BytesIO(part['content'])).pages]
    assert widths==list(range(100,107))+list(range(200,207))
    assert [d.content for d in documents]==originals
    assert parts[0]['pages'][0]==1 and parts[-1]['pages'][1]==14


@pytest.mark.django_db(transaction=False)  # Roll back append-only organization audit rows; do not flush them.
def test_task_delivery_rechecks_shared_access_before_send(org):
    ws=org.ok('A','tm.workspace.save',{'name':'Task PDFs','kind':'PUBLIC'})['id'];task=create(org,'A',ws)
    ids=[org.ok('A','tm.file.add',{'task_id':task,'name':f'{i}.pdf','base64':b64(pdf([100+i]))})['id'] for i in range(2)]
    assert share(org,'A',task,[('E','VIEWER')]).status_code==200
    connect(org.clients['R'],org.ids['E'])
    job=org.ok('E','tm.task.delivery.create',{'task_id':task,'file_ids':ids,'mode':'MERGED_PDF','preview':True,'request_key':str(uuid.uuid4())})['delivery']
    service.process_next(lambda *a:pytest.fail('Preview only'))
    org.ok('E','tm.task.delivery.confirm',{'delivery_id':job['id']})
    assert share(org,'A',task,[]).status_code==200
    service.process_next(lambda *a:pytest.fail('Revoked share must not send'))
    assert BoardDelivery.objects.get(id=job['id']).status=='FAILED'
    assert org.clients['E'].get(f'/api/tasks/delivery?id={task}&delivery={job["id"]}').status_code==404
