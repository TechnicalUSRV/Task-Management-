"""Behavioural parity with V5.7.7: the same scenario runs on the original Node/SQLite service and on Django.

Every step's outcome (result, or refusal message and HTTP status) and the stored rows afterwards (tasks, people on them,
history, notifications, activity log, requests, approvals, steps, files, time entries, workspaces, profiles…) must be
identical; only timestamps are masked. The Node side needs Node.js 22.5+ (node:sqlite) and the V5.7.7 sources in
source/local-test; without them these tests are skipped.
"""
import json
import os
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.parity.driver import Scenario

HERE = Path(__file__).parent
SOURCE = Path(os.environ.get('V577_SOURCE', HERE.parent.parent / 'source' / 'local-test'))
NODE = shutil.which('node')
pytestmark = pytest.mark.skipif(not NODE or not (SOURCE / 'service.mjs').exists(),
                                reason='Node.js and the V5.7.7 sources are needed for parity tests')

PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='
NAMES = {'ADMIN': 'Vanna Admin', 'SOPHEA': 'Sophea Manager', 'DARA': 'Dara Member', 'KOSAL': 'Kosal Member', 'NEARY': 'Neary Viewer'}
ADMIN, SOPHEA, DARA, KOSAL, NEARY = (f'${{staff:{n}}}' for n in NAMES.values())


def node_run(scenario):
    done = subprocess.run([NODE, '--no-warnings', str(HERE / 'parity' / 'v577_driver.mjs'), str(SOURCE)], input=json.dumps(scenario),
                          capture_output=True, text=True, timeout=600)
    assert done.returncode == 0, done.stderr[-4000:]
    return json.loads(done.stdout)


def masked(value, volatile=()):
    if isinstance(value, dict):
        # The legacy server has no account language. Assert the new default
        # before excluding this additive field from the legacy comparison.
        if {'username', 'staff_id', 'role_id', 'language'} <= value.keys():
            assert value['language'] == 'en', 'Legacy scenarios must keep English as their default'
            value = {k: v for k, v in value.items() if k != 'language'}
        return {k: ('<t>' if (k.endswith('_at') or k in volatile) and v is not None else masked(v, volatile)) for k, v in value.items()}
    if isinstance(value, list):
        return [masked(v, volatile) for v in value]
    return value


def compare(scenario, volatile=()):
    expected, actual = node_run(scenario), Scenario().play(scenario)
    assert len(expected['steps']) == len(actual['steps'])
    for i, (want, got) in enumerate(zip(expected['steps'], actual['steps'])):
        assert masked(got, volatile) == masked(want, volatile), f'step {i} {json.dumps(scenario["steps"][i])}\n V5.7.7: {want}\n Django: {got}'
    for table, want in expected['dump'].items():
        got = actual['dump'][table]
        if got != want:
            lines = [f'{table}: V5.7.7 has {len(want)} rows, Django {len(got)}']
            for a, b in zip(want, got):
                if a != b:
                    lines += [' V5.7.7: ' + json.dumps(a, ensure_ascii=False), ' Django: ' + json.dumps(b, ensure_ascii=False)]
                    break
            if len(want) != len(got):
                extra = want[len(got):] or got[len(want):]
                lines.append(' first extra row: ' + json.dumps(extra[0], ensure_ascii=False))
            pytest.fail('\n'.join(lines))
    return expected


def people():
    user = lambda name, role: {'as': ADMIN, 'do': 'admin.user.save', 'data': {'username': name, 'password': name.split()[0] + '-password-2026', 'role_id': role, 'active': 1}}
    return [{'bootstrap': {'username': 'Vanna Admin', 'password': 'Admin-password-2026'}},
            user('Sophea Manager', 'ROLE-MANAGER'), user('Dara Member', 'ROLE-MEMBER'), user('Kosal Member', 'ROLE-MEMBER'),
            user('Neary Viewer', 'ROLE-VIEWER')]


def legacy_workspace():
    return {'as': SOPHEA, 'do': 'tm.workspace.save', 'data': {'name': 'Operations', 'owner_id': SOPHEA, 'member_ids': [SOPHEA, DARA, KOSAL]}}


def test_two_party_task_lifecycle(db):
    base = len(people()) + 1
    w, t = base - 1, base
    steps = people() + [legacy_workspace(),
        {'as': SOPHEA, 'do': 'tm.task.save', 'data': {'workspace_id': f'${{{w}.id}}', 'title': 'Prepare the quarterly stock count',
                                                        'description': 'Count every shelf and reconcile.', 'start_date': '${today}', 'due_date': '${today:7}',
                                                        'pic_id': DARA, 'supporter_ids': [KOSAL], 'estimate': '2:30', 'steps': ['Print sheets', 'Count']}},
        {'as': DARA, 'do': 'tm.task.accept', 'data': {'id': f'${{{t}.id}}'}},
        {'as': DARA, 'do': 'tm.task.accept', 'data': {'id': f'${{{t}.id}}'}},
        {'as': KOSAL, 'do': 'tm.task.decline', 'data': {'id': f'${{{t}.id}}'}},
        {'as': KOSAL, 'do': 'tm.task.accept', 'data': {'id': f'${{{t}.id}}'}},
        {'as': DARA, 'do': 'tm.task.progress', 'data': {'id': f'${{{t}.id}}', 'progress': 40, 'note': 'Half the shelves done'}},
        {'as': f'${{approver:@change:@{t}.id}}', 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{t}.id}}', 'decision': 'APPROVE'}},
        {'as': DARA, 'do': 'tm.task.progress', 'data': {'id': f'${{{t}.id}}', 'progress': 150}},
        {'as': SOPHEA, 'do': 'tm.task.save', 'data': {'id': f'${{{t}.id}}', 'expected_version': f'${{version:tm_tasks:@{t}.id}}', 'workspace_id': f'${{{w}.id}}',
                                                        'title': 'Prepare the quarterly stock count', 'start_date': '${today}', 'due_date': '${today:5}', 'pic_id': DARA,
                                                        'change_note': 'Audit moved earlier'}},
        {'as': DARA, 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{t}.id}}', 'decision': 'REJECT'}},
        {'as': DARA, 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{t}.id}}', 'decision': 'REJECT', 'note': 'Too soon'}},
        {'as': KOSAL, 'do': 'tm.due.request', 'data': {'task_id': f'${{{t}.id}}', 'proposed_due_date': '${today:10}', 'reason': 'Supplier is late'}},
        {'as': SOPHEA, 'do': 'tm.due.decide', 'data': {'id': f'${{due:@{t}.id}}', 'decision': 'APPROVE'}},
        {'as': DARA, 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{t}.id}}', 'decision': 'APPROVE', 'note': 'Fine'}},
        {'as': DARA, 'do': 'tm.check.toggle', 'data': {'id': f'${{step:1:@{t}.id}}', 'done': True}},
        {'as': DARA, 'do': 'tm.check.toggle', 'data': {'id': f'${{step:1:@{t}.id}}', 'done': True}},
        {'as': KOSAL, 'do': 'tm.check.add', 'data': {'task_id': f'${{{t}.id}}', 'title': 'Reconcile'}},
        {'as': KOSAL, 'do': 'tm.check.move', 'data': {'id': f'${{step:3:@{t}.id}}', 'direction': 'up'}},
        {'as': KOSAL, 'do': 'tm.check.rename', 'data': {'id': f'${{step:2:@{t}.id}}', 'title': 'Reconcile the counts'}},
        {'as': DARA, 'do': 'tm.check.remove', 'data': {'id': f'${{step:3:@{t}.id}}'}},
        {'as': DARA, 'do': 'tm.task.stuck', 'data': {'id': f'${{{t}.id}}', 'note': 'Scanner broken'}},
        {'as': DARA, 'do': 'tm.task.stuck', 'data': {'id': f'${{{t}.id}}', 'note': 'Scanner broken'}},
        {'as': SOPHEA, 'do': 'tm.task.resume', 'data': {'id': f'${{{t}.id}}'}},
        {'as': KOSAL, 'do': 'tm.task.note', 'data': {'id': f'${{{t}.id}}', 'note': 'New scanner arrives Monday'}},
        {'as': KOSAL, 'do': 'tm.task.note', 'data': {'id': f'${{{t}.id}}', 'note': 'New scanner arrives Monday'}},
        {'as': DARA, 'do': 'tm.file.add', 'data': {'task_id': f'${{{t}.id}}', 'name': 'shelf.png', 'base64': PNG}},
        {'as': DARA, 'do': 'tm.file.add', 'data': {'task_id': f'${{{t}.id}}', 'name': 'fake.pdf', 'base64': PNG}},
        {'as': NEARY, 'do': 'tm.task.note', 'data': {'id': f'${{{t}.id}}', 'note': 'I should not see this'}},
        {'as': DARA, 'do': 'tm.time.save', 'data': {'task_id': f'${{{t}.id}}', 'work_date': '${today}', 'duration': '1:30', 'notes': 'Counting'}},
        {'as': DARA, 'do': 'tm.time.save', 'data': {'task_id': f'${{{t}.id}}', 'work_date': '${today}', 'duration': '0:30'}},
        {'as': SOPHEA, 'do': 'tm.time.save', 'data': {'task_id': f'${{{t}.id}}', 'staff_id': KOSAL, 'work_date': '${today}', 'duration': '0:45'}},
        {'as': DARA, 'do': 'tm.task.submit', 'data': {'id': f'${{{t}.id}}', 'note': 'All counted'}},
        {'as': DARA, 'do': 'tm.task.submit', 'data': {'id': f'${{{t}.id}}'}},
        {'as': SOPHEA, 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{t}.id}}', 'decision': 'APPROVE', 'note': 'Good work'}},
        {'as': DARA, 'do': 'tm.file.remove', 'data': {'id': f'${{file:@{t}.id}}'}},
        {'as': SOPHEA, 'do': 'tm.task.reopen', 'data': {'id': f'${{{t}.id}}', 'reason': 'One shelf was missed'}},
        {'as': DARA, 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{t}.id}}', 'decision': 'APPROVE'}},
        {'as': SOPHEA, 'do': 'tm.task.cancel', 'data': {'id': f'${{{t}.id}}', 'reason': 'Audit cancelled'}},
        {'as': DARA, 'do': 'tm.change.withdraw', 'data': {'id': f'${{change:@{t}.id}}'}},
        {'as': SOPHEA, 'do': 'tm.change.withdraw', 'data': {'id': f'${{change:@{t}.id}}', 'note': 'Changed my mind'}},
        {'as': DARA, 'do': 'tm.notification.read', 'data': {'all': True}},
        {'as': KOSAL, 'do': 'tm.notification.read', 'data': {'id': '${notification:task_note:@staff:Kosal Member}'}},
        {'as': SOPHEA, 'do': 'tm.task.reminders', 'data': {'id': f'${{{t}.id}}', 'reminder_days': [7, 3, 1]}},
    ]
    compare({'steps': steps})


def test_personal_tasks_requests_and_repeats(db):
    base = len(people())
    steps = people() + [
        legacy_workspace(),
        {'as': DARA, 'do': 'tm.task.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Weekly report', 'description': 'Send the weekly report.',
                                                      'start_date': '${today}', 'due_date': '${today:2}', 'pic_id': DARA, 'recurrence': 'WEEKLY', 'status': 'IN_PROGRESS', 'progress': 10}},
        {'as': DARA, 'do': 'tm.task.progress', 'data': {'id': f'${{{base + 1}.id}}', 'progress': 60}},
        {'as': DARA, 'do': 'tm.task.close', 'data': {'id': f'${{{base + 1}.id}}', 'note': 'Sent'}},
        {'as': DARA, 'do': 'tm.task.save', 'data': {'id': f'${{{base + 3}.next_id}}', 'expected_version': 0, 'workspace_id': f'${{{base}.id}}',
                                                      'title': 'Weekly report (team)', 'start_date': '${today}', 'due_date': '${today:9}', 'pic_id': DARA}},
        {'as': SOPHEA, 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{base + 3}.next_id}}', 'decision': 'APPROVE'}},
        {'as': KOSAL, 'do': 'tm.request.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Fix the loading dock light', 'description': 'It flickers.',
                                                         'manager_id': SOPHEA, 'proposed_due_date': '${today:3}', 'doer': 'RECEIVER', 'request_key': 'k1'}},
        {'as': KOSAL, 'do': 'tm.request.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Fix the loading dock light', 'description': 'It flickers.',
                                                         'manager_id': SOPHEA, 'proposed_due_date': '${today:3}', 'doer': 'RECEIVER', 'request_key': 'k1'}},
        {'as': SOPHEA, 'do': 'tm.request.forward', 'data': {'id': f'${{{base + 6}.id}}', 'manager_id': DARA, 'note': 'Dara knows the electrician'}},
        {'as': DARA, 'do': 'tm.request.decide', 'data': {'id': f'${{{base + 6}.id}}', 'decision': 'APPROVE', 'workspace_id': f'${{{base}.id}}'}},
        {'as': DARA, 'do': 'tm.request.decide', 'data': {'id': f'${{{base + 6}.id}}', 'decision': 'APPROVE'}},
        {'as': DARA, 'do': 'tm.request.save', 'data': {'title': 'Order more pallets', 'description': 'We are short.', 'manager_id': KOSAL, 'doer': 'REQUESTER'}},
        {'as': KOSAL, 'do': 'tm.request.decide', 'data': {'id': f'${{{base + 11}.id}}', 'decision': 'DECLINE'}},
        {'as': KOSAL, 'do': 'tm.request.decide', 'data': {'id': f'${{{base + 11}.id}}', 'decision': 'DECLINE', 'note': 'Already ordered'}},
        {'as': DARA, 'do': 'tm.task.handover', 'data': {'id': f'${{{base + 9}.id}}', 'to_id': KOSAL, 'keep': True, 'note': 'Over to you'}},
        {'as': f'${{approver:@change:@{base + 9}.id}}', 'do': 'tm.change.decide', 'data': {'id': f'${{change:@{base + 9}.id}}', 'decision': 'APPROVE'}},
        {'as': SOPHEA, 'do': 'tm.task.remind', 'data': {'id': f'${{{base + 9}.id}}'}},
        {'as': KOSAL, 'do': 'tm.task.accept', 'data': {'id': f'${{{base + 9}.id}}'}},
        {'as': SOPHEA, 'do': 'tm.profile.manager', 'data': {'staff_id': DARA, 'manager_id': SOPHEA}},
        {'as': ADMIN, 'do': 'tm.profile.manager', 'data': {'staff_id': DARA, 'manager_id': SOPHEA}},
        {'as': ADMIN, 'do': 'tm.profile.manager', 'data': {'staff_id': SOPHEA, 'manager_id': DARA}},
        {'as': DARA, 'do': 'me.profile.save', 'data': {'nickname': 'D'}},
        {'as': DARA, 'do': 'me.profile.save', 'data': {'sidebar_theme': 'teal'}},
        {'as': DARA, 'do': 'me.profile.save', 'data': {'timezone': 'Asia/Bangkok'}},
        {'as': DARA, 'do': 'me.profile.save', 'data': {'timezone': 'Mars/Base'}},
        {'as': DARA, 'do': 'me.photo.save', 'data': {'base64': PNG}},
        {'as': DARA, 'do': 'me.photo.remove', 'data': {}},
        {'as': DARA, 'do': 'me.photo.remove', 'data': {}},
        {'as': SOPHEA, 'do': 'tm.profile.save', 'data': {'name': 'Rotha Driver', 'position': 'Driver', 'active': 1}},
        {'as': SOPHEA, 'do': 'tm.task.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Deliver to the north branch', 'description': 'Two pallets.',
                                                        'start_date': '${today}', 'due_date': '${today:1}', 'pic_id': '${staff:Rotha Driver}'}},
        {'reminders': '2099-01-01T00:00:00Z'},
    ]
    compare({'steps': steps})


# ---------------------------------------------------------------- random walks
# Long random sequences of task work by five people (with stale versions, wrong people, missing notes and repeated taps),
# compared step by step. Any rule that differs shows up as the first step whose outcome differs.
ACTORS = [ADMIN, SOPHEA, DARA, KOSAL, NEARY]
VERBS = ['accept', 'decline', 'progress', 'stuck', 'resume', 'submit', 'pass', 'return', 'close', 'cancel', 'reopen', 'note']


def random_walk(seed, length=160):
    rnd = random.Random(seed)
    steps = people() + [legacy_workspace(),
                        {'as': SOPHEA, 'do': 'tm.workspace.save', 'data': {'name': 'Field team', 'owner_id': DARA, 'member_ids': [DARA, KOSAL, SOPHEA]}}]
    workspaces = ['${5.id}', '${6.id}']
    workers = [SOPHEA, DARA, KOSAL]
    tasks = [f'TASK-{n:06d}' for n in range(1, 7)]

    def create(actor, pic, supporters=(), reviewer=None, recurrence=None, status=None):
        data = {'workspace_id': rnd.choice(workspaces), 'title': rnd.choice(['Stock count', 'Repair the gate', 'Call the supplier']),
                'description': 'Do it well.', 'start_date': '${today}', 'due_date': '${today:%d}' % rnd.randint(0, 20), 'pic_id': pic,
                'supporter_ids': list(supporters), 'estimate': rnd.choice(['1:00', '0:30']), 'steps': rnd.choice([[], ['Measure', 'Report']])}
        for k, v in (('reviewer_id', reviewer), ('recurrence', recurrence), ('status', status)):
            if v:
                data[k] = v
        return {'as': actor, 'do': 'tm.task.save', 'data': data}
    # Six tasks that certainly exist: assigned to someone else (two-sided), self-assigned, with supporters, with another
    # reviewer, repeating, and one started by its person in charge.
    steps += [create(SOPHEA, DARA, [KOSAL]), create(DARA, DARA), create(SOPHEA, KOSAL, [DARA], reviewer=DARA),
              create(KOSAL, DARA, recurrence='WEEKLY'), create(DARA, DARA, [KOSAL], recurrence='DAILY', status='IN_PROGRESS'),
              create(SOPHEA, SOPHEA, [DARA, KOSAL], reviewer=KOSAL)]
    who = lambda: rnd.choice(workers) if rnd.random() < 0.85 else rnd.choice([ADMIN, NEARY])
    note = lambda: rnd.choice([None, '', 'Because the client asked', 'Checked twice', 'Checked twice'])
    day = lambda: '${today:%d}' % rnd.randint(-2, 20)
    for _ in range(length):
        t = rnd.choice(tasks)
        kind = rnd.random()
        if kind < 0.06:
            data = {'workspace_id': rnd.choice(workspaces), 'title': 'Another job', 'description': rnd.choice(['Do it.', '']),
                    'start_date': '${today}', 'due_date': day(), 'pic_id': who(), 'supporter_ids': rnd.sample(workers, rnd.randint(0, 2)),
                    'priority': rnd.choice(['HIGH', 'LOW', None]), 'estimate': rnd.choice(['1:00', None, 'abc']),
                    'status': rnd.choice([None, None, 'IN_PROGRESS', 'COMPLETED']), 'recurrence': rnd.choice([None, 'MONTHLY']),
                    'reminder_days': rnd.choice([None, [3, 1], [0]])}
            steps.append({'as': who(), 'do': 'tm.task.save', 'data': {k: v for k, v in data.items() if v is not None}})
        elif kind < 0.16:
            data = {'id': t, 'expected_version': f'${{version:tm_tasks:{t}}}' if rnd.random() < 0.9 else 99, 'workspace_id': '${0.none}',
                    'title': rnd.choice(['Stock count', 'Stock count (revised)']), 'start_date': '${today}', 'due_date': day(), 'change_note': note(),
                    'description': rnd.choice([None, 'Updated expectation'])}
            data.pop('workspace_id')
            if rnd.random() < 0.4:
                data['pic_id'] = who()
            if rnd.random() < 0.3:
                data['supporter_ids'] = rnd.sample(workers, rnd.randint(0, 2))
            if rnd.random() < 0.2:
                data['reviewer_id'] = who()
            if rnd.random() < 0.2:
                data['recurrence'] = rnd.choice(['', 'WEEKLY'])
            if rnd.random() < 0.1:
                data['move_series'] = True
            steps.append({'as': who(), 'do': 'tm.task.save', 'data': {k: v for k, v in data.items() if v is not None}})
        elif kind < 0.46:
            verb = rnd.choice(VERBS)
            data = {'id': t, 'note': note()}
            if verb == 'progress':
                data['progress'] = rnd.choice([10, 50, 99, 100, '', 30, '40'])
            if verb in ('accept', 'decline') and rnd.random() < 0.3:
                data['role'] = rnd.choice(['pic', 'supporter', 'reviewer'])
            if verb == 'cancel' and rnd.random() < 0.5:
                data['keep_series'] = True
            if rnd.random() < 0.1:
                data['expected_version'] = f'${{version:tm_tasks:{t}}}'
            steps.append({'as': who(), 'do': f'tm.task.{verb}', 'data': {k: v for k, v in data.items() if v is not None}})
        elif kind < 0.58:
            actor = f'${{approver:@change:{t}}}' if rnd.random() < 0.85 else who()
            steps.append({'as': actor, 'do': 'tm.change.decide',
                          'data': {'id': f'${{change:{t}}}', 'decision': rnd.choice(['APPROVE', 'APPROVE', 'REJECT']), 'note': note()}})
        elif kind < 0.61:
            steps.append({'as': who(), 'do': 'tm.change.withdraw', 'data': {'id': f'${{change:{t}}}'}})
        elif kind < 0.67:
            steps.append({'as': who(), 'do': 'tm.due.request', 'data': {'task_id': t, 'proposed_due_date': day(), 'reason': rnd.choice(['Late parts', 'Late parts', ''])}})
        elif kind < 0.72:
            steps.append({'as': who(), 'do': rnd.choice(['tm.due.decide', 'tm.due.decide', 'tm.due.withdraw']),
                          'data': {'id': f'${{due:{t}}}', 'decision': rnd.choice(['APPROVE', 'DECLINE']), 'note': note()}})
        elif kind < 0.78:
            action = rnd.choice(['tm.check.add', 'tm.check.toggle', 'tm.check.toggle', 'tm.check.rename', 'tm.check.move', 'tm.check.remove'])
            data = {'task_id': t, 'title': rnd.choice(['Measure', 'Report']), 'id': f'${{step:{rnd.randint(1, 3)}:{t}}}',
                    'done': rnd.choice([True, False, 1]), 'direction': rnd.choice(['up', 'down', None]), 'position': rnd.choice([1, 2, 5])}
            steps.append({'as': who(), 'do': action, 'data': {k: v for k, v in data.items() if v is not None}})
        elif kind < 0.81:
            if rnd.random() < 0.7:
                steps.append({'as': who(), 'do': 'tm.file.add', 'data': {'task_id': t, 'name': rnd.choice(['photo.png', 'C:\\x\\scan.PNG', 'run.exe']), 'base64': PNG}})
            else:
                steps.append({'as': who(), 'do': 'tm.file.remove', 'data': {'id': f'${{file:{t}}}'}})
        elif kind < 0.85:
            steps.append({'as': who(), 'do': 'tm.task.handover', 'data': {'id': t, 'to_id': who(), 'keep': rnd.choice([True, False]), 'note': note()}})
        elif kind < 0.87:
            steps.append({'as': who(), 'do': rnd.choice(['tm.task.remind', 'tm.task.reminders']),
                          'data': {'id': t, 'reminder_days': rnd.choice([[1], [7, 2], [], [91], ['3']])}})
        elif kind < 0.93:
            action = rnd.choice(['tm.request.save', 'tm.request.save', 'tm.request.decide', 'tm.request.decide', 'tm.request.forward', 'tm.request.withdraw'])
            req = f'REQ-{rnd.randint(1, 3):06d}'
            data = {'title': 'Please help', 'description': 'Details', 'manager_id': who(), 'doer': rnd.choice(['RECEIVER', 'REQUESTER', 'DECIDE', None]),
                    'workspace_id': rnd.choice(workspaces + [None]), 'proposed_due_date': rnd.choice([day(), None])} if action == 'tm.request.save' else {
                'id': req, 'decision': rnd.choice(['APPROVE', 'APPROVE', 'DECLINE']), 'note': note(), 'manager_id': who(),
                'workspace_id': rnd.choice(workspaces + [None]), 'pic_id': rnd.choice([who(), None]), 'due_date': rnd.choice([day(), None])}
            steps.append({'as': who(), 'do': action, 'data': {k: v for k, v in data.items() if v is not None}})
        elif kind < 0.97:
            if rnd.random() < 0.8:
                steps.append({'as': who(), 'do': 'tm.time.save', 'data': {'task_id': t, 'staff_id': who(), 'work_date': '${today:%d}' % rnd.randint(-3, 1),
                                                                             'duration': rnd.choice(['1:00', '0:15', '25:00', '0:00', '2:30'])}})
            else:
                steps.append({'as': who(), 'do': 'tm.time.delete', 'data': {'id': f'TIME-{rnd.randint(1, 3):06d}', 'expected_version': 0,
                                                                               'reason': rnd.choice(['Wrong day', ''])}})
        else:
            steps.append({'as': who(), 'do': 'tm.notification.read', 'data': {'all': True}})
    steps.append({'reminders': '2099-01-01T00:00:00Z'})
    return {'steps': steps}


@pytest.mark.parametrize('seed', range(int(os.environ.get('PARITY_SEEDS', '8'))))
def test_random_task_work_matches_v577(db, seed):
    compare(random_walk(seed))


def test_meetings_calendar_notes_and_reminders(db):
    from tasks import domain as dm
    tomorrow = dm.add_days(dm.task_today(), 1)
    at = lambda day, hm: f'{day}T{hm}:00.000Z'
    base = len(people())
    m1 = base + 1
    steps = people() + [legacy_workspace(),
        {'as': SOPHEA, 'do': 'tm.meeting.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Weekly planning', 'agenda': 'Plan the week',
                                                           'attendee_ids': [DARA], 'start_at': at(tomorrow, '02:00'), 'end_at': at(tomorrow, '03:00'),
                                                           'location': 'Room 1', 'url': 'https://Meet.Example.com/abc', 'reminder_offsets': [60, 15],
                                                           'share_scope': 'SELECTED', 'share_ids': [NEARY], 'request_key': 'm1'}},
        {'as': SOPHEA, 'do': 'tm.meeting.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Weekly planning', 'attendee_ids': [DARA],
                                                           'start_at': at(tomorrow, '02:00'), 'end_at': at(tomorrow, '03:00'), 'request_key': 'm1'}},
        {'as': KOSAL, 'do': 'tm.meeting.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Clash', 'attendee_ids': [DARA],
                                                          'start_at': at(tomorrow, '02:30'), 'end_at': at(tomorrow, '04:00')}},
        {'as': KOSAL, 'do': 'tm.meeting.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Too early', 'start_at': '2020-01-01T00:00:00.000Z',
                                                          'end_at': '2020-01-01T01:00:00.000Z'}},
        {'as': KOSAL, 'do': 'tm.meeting.save', 'data': {'workspace_id': f'${{{base}.id}}', 'title': 'Bad link', 'start_at': at(tomorrow, '05:00'),
                                                          'end_at': at(tomorrow, '06:00'), 'url': 'ftp://files.example.com'}},
        {'as': NEARY, 'do': 'tm.meeting.follow', 'data': {'id': f'${{{m1}.id}}', 'follow': True}},
        {'as': NEARY, 'do': 'tm.meeting.follow', 'data': {'id': f'${{{m1}.id}}', 'follow': True}},
        {'as': DARA, 'do': 'tm.meeting.follow', 'data': {'id': f'${{{m1}.id}}', 'follow': True}},
        {'as': DARA, 'do': 'tm.meeting.save', 'data': {'id': f'${{{m1}.id}}', 'expected_version': 0, 'title': 'Weekly planning', 'attendee_ids': [DARA, KOSAL],
                                                         'start_at': at(tomorrow, '04:00'), 'end_at': at(tomorrow, '05:00'), 'location': 'Room 2',
                                                         'change_note': 'Room 1 is booked'}},
        {'as': DARA, 'do': 'tm.meeting.save', 'data': {'id': f'${{{m1}.id}}', 'expected_version': 0, 'title': 'Weekly planning',
                                                         'start_at': at(tomorrow, '04:00'), 'end_at': at(tomorrow, '05:00')}},
        {'as': DARA, 'do': 'tm.meeting.decide', 'data': {'id': f'${{mchange:@{m1}.id}}', 'decision': 'APPROVE'}},
        {'as': SOPHEA, 'do': 'tm.meeting.decide', 'data': {'id': f'${{mchange:@{m1}.id}}', 'decision': 'APPROVE', 'expected_version': 0}},
        {'as': SOPHEA, 'do': 'tm.meeting.save', 'data': {'id': f'${{{m1}.id}}', 'expected_version': '${version:tm_meetings:@%d.id}' % m1,
                                                           'title': 'Weekly planning', 'attendee_ids': [DARA, KOSAL], 'start_at': at(tomorrow, '04:00'),
                                                           'end_at': at(tomorrow, '05:00'), 'status': 'CANCELLED', 'reason': 'Holiday'}},
        {'as': DARA, 'do': 'tm.meeting.decide', 'data': {'id': f'${{mchange:@{m1}.id}}', 'decision': 'REJECT', 'expected_version': 0}},
        {'as': DARA, 'do': 'tm.meeting.decide', 'data': {'id': f'${{mchange:@{m1}.id}}', 'decision': 'REJECT', 'expected_version': 0, 'note': 'Not a holiday'}},
        {'event_reminders': at(tomorrow, '03:50')},
        {'event_reminders': at(tomorrow, '03:52')},
        {'as': DARA, 'do': 'tm.calnote.save', 'data': {'title': 'Dentist', 'day': dm.add_days(dm.task_today(), 3), 'reminder_offsets': [1440]}},
        {'as': DARA, 'do': 'tm.calnote.save', 'data': {'title': 'Call bank', 'all_day': False, 'start_at': at(tomorrow, '07:00'),
                                                         'end_at': at(tomorrow, '06:00')}},
        {'as': DARA, 'do': 'tm.calnote.save', 'data': {'title': 'Call bank', 'all_day': False, 'start_at': at(tomorrow, '07:00'), 'reminder_offsets': '[30]',
                                                         'body': 'Ask about the loan'}},
        {'as': KOSAL, 'do': 'tm.calnote.save', 'data': {'id': '${%d.id}' % (base + 18), 'title': 'Mine now', 'expected_version': 0}},
        {'as': DARA, 'do': 'tm.calnote.save', 'data': {'id': '${%d.id}' % (base + 20), 'title': 'Call the bank', 'expected_version': 0, 'done': True}},
        {'event_reminders': at(tomorrow, '06:40')},
        {'as': DARA, 'do': 'tm.calnote.delete', 'data': {'id': '${%d.id}' % (base + 18), 'expected_version': 0}},
        {'as': KOSAL, 'do': 'tm.time.save', 'data': {'workspace_id': f'${{{base}.id}}', 'activity': 'Warehouse walk-through', 'work_date': '${today}',
                                                       'duration': '0:45'}},
        {'as': KOSAL, 'do': 'tm.time.save', 'data': {'id': '${%d.id}' % (base + 25), 'expected_version': 0, 'work_date': '${today:-1}', 'duration': '1:00'}},
        {'as': SOPHEA, 'do': 'tm.time.delete', 'data': {'id': '${%d.id}' % (base + 25), 'expected_version': 1, 'reason': 'Duplicate'}},
        {'as': KOSAL, 'do': 'tm.time.delete', 'data': {'id': '${%d.id}' % (base + 25), 'expected_version': 1, 'reason': 'Duplicate'}},
        {'as': SOPHEA, 'do': 'tm.workspace.archive', 'data': {'id': f'${{{base}.id}}', 'expected_version': 0, 'status': 'ARCHIVED'}},
    ]
    compare({'steps': steps})


VOLATILE = {'generated_at', 'today', 'change_seq', 'app_build'}


def unvolatile(value):
    if isinstance(value, dict) and isinstance(value.get('task_scope'), dict):
        # The scope revision is a cache key that includes a per-process random value in V5.7.7.
        value = {**value, 'task_scope': {**value['task_scope'], 'revision': '<v>'}}
    if isinstance(value, dict) and isinstance(value.get('recent'), list):
        # Newest first: events written in the same millisecond tie, and timing differs between the two servers.
        # Which eight are newest then depends on timing, so only their number is compared.
        value = {**value, 'recent': len(value['recent'])}
    if isinstance(value, dict):
        return {k: ('<v>' if k in VOLATILE or (k.endswith('_at') and v is not None) or k == 'since' else unvolatile(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [unvolatile(v) for v in value]
    return value


HIDDEN = ('admin.integrations',)


def as_deployed(value):
    """V5.7.7 output as this deployment shows it: the Google Sheets connection is not offered (decision A). Groups are
    offered exactly as in V5.7.7."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == 'permissions' and isinstance(v, dict):
                v = {r: ([] if r in HIDDEN else a) for r, a in v.items()}
            elif k == 'erp_catalog':
                v = [{**m, 'functions': [f for f in m['functions'] if f['key'] not in HIDDEN]} for m in v]
            out[k] = as_deployed(v)
        return out
    if isinstance(value, list):
        return [as_deployed(v) for v in value]
    return value


def legacy_mini_contract(step, answer):
    """Only the four new Mini App Group fields are outside the V5.7.7 contract.

    They are verified against the scoped office state by test_group_enhancements.
    Every pre-existing field still has to match the original implementation exactly.
    """
    if step.get('read') != 'mini' or not answer.get('ok'):
        return answer
    result = dict(answer['result'])
    for key in ('tm_boards', 'tm_board_access', 'tm_board_summaries', 'tm_group_workspaces'):
        assert key in result and isinstance(result[key], list), key
        result.pop(key)
    return {**answer, 'result': result}


MANAGEMENT_ACCESS = ('manager_ids', 'can_set_managers', 'can_make_public', 'manager_options')


def management_contract(step, answer):
    """Fields added for responsible managers, additional reporting lines and Under My Management are outside the V5.7.7
    contract. Each must be present with its shape (they are verified by test_management_scope); they are then removed so
    every pre-existing field is still compared exactly with the original implementation."""
    if not isinstance(answer, dict) or not answer.get('ok') or not isinstance(answer.get('result'), dict):
        return answer
    result = dict(answer['result'])

    def strip_access(w):
        access = w.get('org_access')
        if isinstance(access, dict) and 'manager_ids' in access:
            assert all(k in access for k in MANAGEMENT_ACCESS), access
            w = {**w, 'org_access': {k: v for k, v in access.items() if k not in MANAGEMENT_ACCESS}}
        return w
    if step.get('read') in ('state', 'mini'):
        for key in ('management_people', 'workspace_setup'):
            if key in result:
                result.pop(key)
        if isinstance(result.get('tm_workspaces'), list):
            result['tm_workspaces'] = [strip_access(w) for w in result['tm_workspaces']]
        board = result.get('workspace_dashboard')
        if isinstance(board, dict):
            result['workspace_dashboard'] = {k: ([strip_access(w) for w in v] if k in ('my', 'managed', 'shared') else v) for k, v in board.items()}
    if step.get('read') == 'org':
        if isinstance(result.get('rows'), list):
            result['rows'] = [({k: v for k, v in r.items() if k != 'additional_manager_ids'} if isinstance(r, dict) else r) for r in result['rows']]
            result['rows'] = [strip_access(r) if isinstance(r, dict) else r for r in result['rows']]
        result.pop('additional_manager_ids', None)
    return {**answer, 'result': result}


def compare_reads(scenario):
    """Like compare(), for steps that read the state, reports or the dashboard: compares them key by key."""
    expected, actual = node_run(scenario), Scenario().play(scenario)
    for i, (want, got) in enumerate(zip(expected['steps'], actual['steps'])):
        want, got = unvolatile(as_deployed(want)), unvolatile(management_contract(scenario['steps'][i], legacy_mini_contract(scenario['steps'][i], got)))
        if want == got:
            continue
        step = scenario['steps'][i]
        if want.get('ok') and got.get('ok') and isinstance(want['result'], dict) and isinstance(got['result'], dict):
            w, g = want['result'], got['result']
            diffs = [k for k in sorted(set(w) | set(g)) if w.get(k, '<missing>') != g.get(k, '<missing>')]
            detail = []
            for k in diffs[:6]:
                a, b = w.get(k, '<missing>'), g.get(k, '<missing>')
                if isinstance(a, list) and isinstance(b, list):
                    for x, y in zip(a, b):
                        if x != y:
                            a, b = x, y
                            break
                    else:
                        a, b = f'{len(a)} rows', f'{len(b)} rows'
                detail.append(f'  {k}:\n   V5.7.7: {json.dumps(a, ensure_ascii=False)[:1500]}\n   Django: {json.dumps(b, ensure_ascii=False)[:1500]}')
            pytest.fail(f"step {i} {json.dumps(step)[:200]}: keys differ {diffs}\n" + '\n'.join(detail))
        pytest.fail(f'step {i} {json.dumps(step)[:300]}\n V5.7.7: {json.dumps(want)[:2000]}\n Django: {json.dumps(got)[:2000]}')


@pytest.mark.parametrize('seed', [3, 11])
def test_state_reports_and_dashboard_match_v577(db, seed):
    walk = random_walk(seed, length=120)['steps']
    # Reporting lines: Kosal reports to Dara, who reports to Sophea (managers see their team's tasks).
    walk += [{'as': ADMIN, 'do': 'tm.profile.manager', 'data': {'staff_id': KOSAL, 'manager_id': DARA}},
             {'as': ADMIN, 'do': 'tm.profile.manager', 'data': {'staff_id': DARA, 'manager_id': SOPHEA}},
             {'as': ADMIN, 'do': 'tm.profile.manager', 'data': {'staff_id': NEARY, 'manager_id': SOPHEA}}]
    reads = []
    for who in (ADMIN, SOPHEA, DARA, KOSAL, NEARY):
        reads += [{'read': 'state', 'as': who}, {'read': 'mini', 'as': who}, {'read': 'dashboard', 'as': who},
                  {'read': 'report', 'as': who, 'input': {'report': 'tasks'}}, {'read': 'report', 'as': who, 'input': {'report': 'workload'}},
                  {'read': 'report', 'as': who, 'input': {'report': 'time'}}, {'read': 'report', 'as': who, 'input': {'report': 'workspace'}},
                  {'read': 'report', 'as': who, 'input': {'report': 'meetings'}}, {'read': 'report', 'as': who, 'input': {'report': 'monthly'}},
                  {'read': 'report', 'as': who, 'input': {'report': 'monthly_overdue', 'user': DARA}},
                  {'read': 'options', 'as': who}, {'read': 'erp', 'as': who, 'input': {'title': 'All my data'}},
                  {'read': 'erp', 'as': who, 'input': {'sources': ['tasks'], 'fields': ['id', 'title', 'users', 'department', 'minutes']}, 'exporting': True},
                  {'read': 'source', 'as': who, 'input': {'sources': ['tasks'], 'statuses': ['IN_PROGRESS']}}]
    compare_reads({'steps': walk + reads})
