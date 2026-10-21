"""Regression checks for Pasted text(7): Task ACLs are independent of Workspace access."""
import base64
import pytest
from django.utils import timezone
from accounts.models import User
from core.rows import row
from organization.governance import Governance
from organization.models import OrgSettings, Profile
from tasks.models import Task, TaskMember
from tasks.domain import task_today, add_days
from workspaces.models import Workspace, WorkspaceMember
from tests.test_management_scope import org, PASSWORD  # noqa: F401
from tests.conftest import Api


def create(org, who, ws, **extra):
    return org.ok(who, 'tm.task.save', {'workspace_id': ws, 'title': 'Confidential work', 'description': 'Expected result',
        'start_date': task_today(), 'due_date': add_days(task_today(), 3), 'pic_id': org.ids[who], **extra})['id']


def sees(org, who, task):
    return any(t['id'] == task for t in org.state(who)['tm_tasks'])


def share(org, who, task, members):
    return org.cmd(who, 'tm.task.members.save', {'id': task, 'expected_version': Task.objects.get(id=task).version,
                                              'members': [{'staff_id': org.ids[k], 'permission': v} for k,v in members]})


def test_workspace_members_do_not_inherit_task_files_history_or_reports(org):
    ws = org.ok('A','tm.workspace.save',{'name':'Shared room','kind':'PUBLIC'})['id']
    WorkspaceMember.objects.create(workspace_id=ws,staff_id=org.ids['E'])
    task = create(org,'A',ws)
    file = org.ok('A','tm.file.add',{'task_id':task,'name':'secret.txt','base64':base64.b64encode(b'private').decode()})['id']
    assert not sees(org,'E',task)
    assert org.clients['E'].get(f'/api/v1/tasks/{task}/').status_code == 404
    assert org.clients['E'].get(f'/api/tasks/file?id={file}').status_code == 404
    state=org.state('E')
    assert not any(h['task_id']==task for h in state['tm_task_history'])
    assert task not in org.clients['E'].get('/api/tasks/report?report=tasks').content.decode()


def test_explicit_shares_contribute_without_workflow_or_workspace_rights(org):
    ws=org.ok('A','tm.workspace.save',{'name':'Shares','kind':'PUBLIC'})['id']; task=create(org,'A',ws)
    assert share(org,'A',task,[('E','VIEWER')]).status_code==200
    assert sees(org,'E',task)
    assert not WorkspaceMember.objects.filter(workspace_id=ws,staff_id=org.ids['E']).exists()
    assert org.cmd('E','tm.task.note',{'id':task,'note':'Denied'}).status_code==403
    assert share(org,'A',task,[('E','CONTRIBUTOR')]).status_code==200
    org.ok('E','tm.task.note',{'id':task,'note':'Contributor note'})
    assert org.cmd('E','tm.task.close',{'id':task,'expected_version':Task.objects.get(id=task).version}).status_code==403
    assert share(org,'E',task,[]).status_code==403
    assert share(org,'A',task,[]).status_code==200
    assert not sees(org,'E',task)
    Task.objects.filter(id=task).update(pic_id=org.ids['E'])
    assert sees(org,'E',task)  # removing a share never removes a responsible role


def test_unselected_governor_cannot_override_explicit_task_scope(org):
    org.ok('R','org.delegation.request',{'beneficiary_id':org.ids['A'],'template_id':'OWNER','reason':'Runs unit'})
    ws=org.ok('A','tm.workspace.save',{'name':'Only C','kind':'ORGANIZATIONAL','manager_ids':[org.ids['C']]})['id']
    task=create(org,'A',ws,pic_id=org.ids['E'])
    assert sees(org,'C',task)
    assert not sees(org,'B',task)


def test_personal_task_and_admin_participation_keep_correct_roles(org):
    ws=org.ok('A','tm.workspace.save',{'name':'Personal task room','kind':'PUBLIC'})['id']
    task=create(org,'A',ws,visibility='PERSONAL')
    assert sees(org,'A',task) and sees(org,'R',task)
    assert not sees(org,'B',task) and not sees(org,'C',task)
    assert share(org,'A',task,[('E','VIEWER')]).status_code==409
    admin_ws=org.ok('R','tm.workspace.save',{'name':'Admin work','kind':'PUBLIC'})['id']
    own=create(org,'R',admin_ws)
    t=next(t for t in org.state('R')['tm_tasks'] if t['id']==own)
    assert t['access_reason']=='involved'


def test_unmapped_user_is_restricted_even_before_structure_is_enabled(org):
    Profile.objects.filter(staff_id=org.ids['E']).update(org_level_id=None)
    OrgSettings.objects.filter(id=1).update(enabled=False)
    state=org.state('E')
    assert state['auth']['permissions']['tasks.tasks']
    assert state['operational_access'] is False
    assert state['tm_tasks']==[] and state['tm_workspaces']==[] and state['tm_boards']==[]
    assert org.cmd('E','tm.workspace.save',{'name':'Bypass','kind':'PUBLIC'}).status_code==403
    assert org.clients['E'].get('/api/tasks/report?report=tasks').status_code==403
    assert org.clients['R'].get('/api/organization?view=people').status_code==200
    Profile.objects.filter(staff_id=org.ids['E']).update(org_level_id=4)
    assert org.state('E')['operational_access'] is True


def test_organizational_task_selects_one_of_multiple_authorized_managers(org):
    org.ok('R','org.delegation.request',{'beneficiary_id':org.ids['A'],'template_id':'OWNER','reason':'Runs unit'})
    ws=org.ok('A','tm.workspace.save',{'name':'Two managers','kind':'ORGANIZATIONAL','manager_ids':[org.ids['B'],org.ids['C']]})['id']
    task=create(org,'A',ws,visibility='ORGANIZATIONAL',governing_manager_id=org.ids['C'])
    assert Task.objects.get(id=task).governing_manager_id==org.ids['C']
    assert sees(org,'C',task) and not sees(org,'B',task)
    choices=next(w for w in org.state('A')['tm_workspaces'] if w['id']==ws)['task_manager_options']
    assert {m['id'] for m in choices}=={org.ids['B'],org.ids['C']}
    r=org.cmd('A','tm.task.save',{'workspace_id':ws,'title':'Bad scope','visibility':'ORGANIZATIONAL','governing_manager_id':org.ids['D'],
                                'pic_id':org.ids['A'],'description':'Result','start_date':task_today(),'due_date':add_days(task_today(),2)})
    assert r.status_code==422


def test_mini_matches_web_task_sharing_and_unmapped_state(org):
    from tests.test_group_enhancements import connect
    from tests.test_telegram import MiniApp, launch
    ws=org.ok('A','tm.workspace.save',{'name':'Mini sharing','kind':'PUBLIC'})['id']
    task=create(org,'A',ws)
    connect(org.clients['R'],org.ids['E'])
    app=MiniApp(launch(777))
    assert not any(t['id']==task for t in app.get('/state').json()['tm_tasks'])
    assert share(org,'A',task,[('E','CONTRIBUTOR')]).status_code==200
    state=app.get('/state').json(); t=next(t for t in state['tm_tasks'] if t['id']==task)
    assert t['task_categories']==['shared']
    assert app.post('/command',{'action':'tm.task.note','data':{'id':task,'note':'From Mini'}}).status_code==200
    Profile.objects.filter(staff_id=org.ids['E']).update(org_level_id=None)
    assert app.get('/state').json()['tm_tasks']==[]
    assert app.post('/command',{'action':'tm.task.note','data':{'id':task,'note':'Denied'}}).status_code==403


def test_task_request_preserves_selected_manager_on_approval(org):
    org.ok('R','org.delegation.request',{'beneficiary_id':org.ids['A'],'template_id':'OWNER','reason':'Runs unit'})
    ws=org.ok('A','tm.workspace.save',{'name':'Requested work','kind':'ORGANIZATIONAL','manager_ids':[org.ids['B'],org.ids['C']]})['id']
    request=org.ok('A','tm.request.save',{'workspace_id':ws,'manager_id':org.ids['C'],'title':'Review proposal',
        'description':'Compare suppliers','visibility':'ORGANIZATIONAL','governing_manager_id':org.ids['C'],
        'proposed_due_date':add_days(task_today(),3)})['id']
    assert org.cmd('C','tm.request.decide',{'id':request,'decision':'APPROVE','visibility':'PERSONAL'}).status_code==422
    task=org.ok('C','tm.request.decide',{'id':request,'decision':'APPROVE'})['id']
    assert Task.objects.get(id=task).governing_manager_id==org.ids['C']
    assert sees(org,'A',task) and sees(org,'C',task) and not sees(org,'B',task)


def test_unmapped_structure_permissions_and_administrator_onboarding(org):
    from accounts.models import UserPermissionOverride
    from organization.models import StaffPhoto
    user=User.objects.get(staff_id=org.ids['E'])
    Profile.objects.filter(staff_id=user.staff_id).update(org_level_id=None)
    for action in ('view','create','update'):
        UserPermissionOverride.objects.create(user=user,resource='tasks.organization',action=action,effect='ALLOW')
    assert org.clients['E'].get('/api/organization?view=people').status_code==200
    assert org.cmd('E','org.level.save',{'level':5,'name':'Assigned employees','expected_revision':OrgSettings.objects.get(id=1).revision}).status_code==403
    assert org.cmd('E','tm.workspace.save',{'name':'Unauthorized','kind':'PUBLIC'}).status_code==403
    for who in ('A','E'):
        StaffPhoto.objects.create(staff_id=org.ids[who],mime='image/png',size=3,content=b'png',updated_at=timezone.now())
    assert org.clients['E'].get('/api/photo?staff='+org.ids['A']).status_code==403
    assert org.clients['E'].get('/api/photo?staff='+org.ids['E']).status_code==200
    # Existing Level 1 Administration still onboards employees under the same approval rules.
    org.ok('R','org.structure.save',{'changes':[{'staff_id':org.ids['E'],'level':3,'manager_id':org.ids['C']}],
        'expected_revision':OrgSettings.objects.get(id=1).revision,'acknowledged':True,'reason':'Onboard employee'})
    assert org.state('E')['operational_access'] is True


def test_bot_keeps_task_data_out_of_group_chats_and_denies_unmapped_users(org):
    from tests.test_group_enhancements import connect
    from tests.test_telegram import TOKEN
    from telegram.bot import Bot
    connect(org.clients['R'],org.ids['E'])
    ws=org.ok('E','tm.workspace.save',{'name':'Digest work','kind':'PUBLIC'})['id']
    create(org,'E',ws,due_date=task_today())
    calls=[]
    bot=Bot(TOKEN,transport={'call':lambda method,params,timeout:calls.append((method,params)) or {'message_id':1}})
    bot.me={'id':999,'username':'sunny_test_bot'}
    sender={'id':777,'first_name':'Employee'}
    group={'id':-123,'type':'supergroup','title':'Team'}
    bot.handle_update({'update_id':1,'message':{'message_id':1,'from':sender,'chat':group,'text':'/tasks'}})
    assert 'private chat' in calls[-1][1]['text']
    bot.handle_update({'update_id':2,'callback_query':{'id':'cb1','from':sender,'data':'t:v:TSK-000001',
        'message':{'message_id':1,'chat':group}}})
    assert calls[-1][0]=='answerCallbackQuery' and 'privacy' in calls[-1][1]['text']
    assert bot.counts(org.ids['E'])['my']==1
    Profile.objects.filter(staff_id=org.ids['E']).update(org_level_id=None)
    bot.handle_update({'update_id':3,'message':{'message_id':2,'from':sender,'chat':{'id':777,'type':'private'},'text':'/mytasks'}})
    assert 'assign' in calls[-1][1]['text'].lower()
    assert not any(bot.counts(org.ids['E']).values())
    from tasks.domain import CAMBODIA
    calls.clear()
    bot.digest({'digest_hour':timezone.now().astimezone(CAMBODIA).hour,'last_digest_date':''})
    assert calls==[]
