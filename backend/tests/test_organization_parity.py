"""Organizational Structure matches V5.7.7: organization-test.mjs, replayed as one scenario on the original service and on
Django. Every command's result or refusal, what each person then reads (state, Mini App, the Organizational Structure
views) and the stored rows (levels, reporting lines, grants, requests, workspaces, members, audit) must be identical.
"""
import json
import re

import pytest

from tests.parity.driver import Scenario
from tests.test_parity import as_deployed, node_run, pytestmark as needs_node, unvolatile

pytestmark = needs_node
PASSWORD = 'Review-organization-2026'
NAMES = {'A': 'Anna Admin', 'B': 'Bopha Manager', 'C': 'Chan Member', 'D': 'Dina Member', 'E': 'Eng Member', 'X': 'Xavier Manager', 'Y': 'Yin Member'}
A, B, C, D, E, X, Y = (f'${{staff:{n}}}' for n in NAMES.values())
REV = '${orgrev}'


def grant(letter):
    return f'${{grant:@staff:{NAMES[letter]}}}'


def last_request(letter):
    return f'${{orgreq:@staff:{NAMES[letter]}}}'


def people():
    steps = [{'bootstrap': {'username': NAMES['A'], 'password': PASSWORD}}]
    for letter, role in (('B', 'MANAGER'), ('C', 'MEMBER'), ('D', 'MEMBER'), ('E', 'MEMBER'), ('X', 'MANAGER'), ('Y', 'MEMBER')):
        steps.append({'as': A, 'do': 'admin.user.save', 'data': {'username': NAMES[letter], 'password': PASSWORD, 'role_id': f'ROLE-{role}', 'active': 1,
                                                                 'function_settings': {'tasks.organization': {'create': 'ALLOW'}}}})
    return steps


def structure(changes, actor=A, reason='Review reporting relationships', **extra):
    return {'as': actor, 'do': 'org.structure.save', 'data': {'expected_revision': REV, 'acknowledged': True, 'reason': reason,
                                                                'changes': [{'staff_id': s, 'level': lv, **({'manager_id': m} if m is not False else {})}
                                                                            for s, lv, m in changes], **extra}}


def workspace(owner, name, kind='ORGANIZATIONAL'):
    return {'as': owner, 'do': 'org.workspace.save', 'data': {'name': name, 'kind': kind, 'owner_id': owner}}


def task(actor, ws, title, **extra):
    return {'as': actor, 'do': 'tm.task.save', 'data': {'workspace_id': f'${{ws:{ws}}}', 'title': title, 'description': 'Deliver the specified outcome',
                                                          'start_date': '${today}', 'due_date': '${today:7}', 'pic_id': actor, **extra}}


def reads(*who, views=('people', 'requests', 'audit', 'workspaces', 'join')):
    out = []
    for w in who:
        out += [{'read': 'state', 'as': w}, {'read': 'mini', 'as': w}, *({'read': 'org', 'as': w, 'input': {'view': v}} for v in views)]
    return out


def scenario():
    everyone = (A, B, C, D, E, X, Y)
    steps = people() + [
        {'as': A, 'do': 'tm.workspace.save', 'data': {'name': 'Legacy warehouse', 'owner_id': B, 'member_ids': [B, C]}},
        {'as': A, 'do': 'tm.workspace.save', 'data': {'name': 'Legacy notes', 'owner_id': E, 'member_ids': [E, Y]}},
        {'read': 'org', 'as': A, 'input': {'view': 'migration'}},
        {'as': C, 'do': 'org.initialize', 'data': {'level1_ids': [C], 'expected_revision': REV, 'reason': 'Too early'}},
        {'as': A, 'do': 'org.initialize', 'data': {'level1_ids': [], 'expected_revision': REV, 'reason': 'Nobody'}},
        {'as': A, 'do': 'org.initialize', 'data': {'level1_ids': [A], 'expected_revision': REV, 'reason': 'Explicit isolated review mapping'}},
        {'as': A, 'do': 'org.initialize', 'data': {'level1_ids': [A], 'expected_revision': REV, 'reason': 'Again'}},
        structure([(B, 2, A), (C, 3, B), (D, 4, C), (E, 5, D), (X, 2, A), (Y, 3, X)]),
        {'as': A, 'do': 'org.level.save', 'data': {'level': 4, 'name': 'Team leads', 'expected_revision': REV}},
        workspace(B, 'Workspace B Operations'), workspace(X, 'Workspace X Separate branch'),
        # Initialization and structure rules.
        {'as': C, 'do': 'org.initialize', 'data': {'level1_ids': [C], 'expected_revision': REV}},
        structure([(C, 1, False)], actor=C, reason='Try promotion'),
        structure([(A, None, False)], reason='Remove last administrator'),
        structure([(Y, 3, B)], actor=B, reason='Other branch'),
        structure([(C, 3, C)], reason='Invalid parent'), structure([(C, 3, D)], reason='Invalid parent'),
        structure([(C, 3, 'FOREIGN-EMPLOYEE')], reason='Invalid parent'),
        workspace(C, 'Unapproved delegated workspace'),
        # Delegation: an explicit Owner grant, then a lower one that waits for the Level 2 approver.
        {'as': B, 'do': 'org.delegation.request', 'data': {'beneficiary_id': C, 'template_id': 'OWNER', 'reason': 'Manage delivery team'}},
        workspace(C, 'Workspace C Delivery'),
        {'as': C, 'do': 'org.delegation.request', 'data': {'beneficiary_id': D, 'template_id': 'OWNER', 'parent_grant_id': grant('C'),
                                                            'reason': 'Separate dispatch workspace', 'request_key': 'D-owner'}},
        {'as': C, 'do': 'org.delegation.request', 'data': {'beneficiary_id': D, 'template_id': 'OWNER', 'parent_grant_id': grant('C'),
                                                            'reason': 'Separate dispatch workspace', 'request_key': 'D-owner'}},
        workspace(D, 'Too early'),
        {'as': C, 'do': 'org.request.decide', 'data': {'id': last_request('C'), 'decision': 'APPROVE'}},
        {'as': X, 'do': 'org.request.decide', 'data': {'id': last_request('C'), 'decision': 'APPROVE'}},
        *reads(B, C, views=('requests',)),
        {'as': B, 'do': 'org.request.decide', 'data': {'id': last_request('C'), 'decision': 'APPROVE'}},
        {'as': B, 'do': 'org.request.decide', 'data': {'id': last_request('C'), 'decision': 'APPROVE'}},
        workspace(D, 'Workspace D Dispatch'),
        # Membership: the creator Owner approves directly within scope; repeats change nothing.
        {'as': D, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Workspace D Dispatch}', 'beneficiary_id': E, 'reason': 'Dispatch work',
                                                            'approver_id': D, 'approved': True}},
        {'as': D, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Workspace D Dispatch}', 'beneficiary_id': E, 'reason': 'Dispatch work'}},
        {'as': D, 'do': 'org.request.decide', 'data': {'id': last_request('D'), 'decision': 'APPROVE'}},
        {'as': B, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Workspace B Operations}', 'beneficiary_id': C, 'reason': 'Direct manager approval'}},
        {'as': B, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Workspace B Operations}', 'beneficiary_id': C, 'member_role': 'VIEWER',
                                                            'reason': 'Review only'}},
        {'as': D, 'do': 'tm.workspace.save', 'data': {'id': '${ws:Workspace D Dispatch}', 'expected_version': 0, 'name': 'Workspace D Dispatch',
                                                       'member_ids': [D, E, Y]}},
        # Personal workspaces stay private, even from managers above.
        workspace(E, 'Private E workspace', 'PERSONAL'),
        task(E, 'Private E workspace', 'PRIVATE E TITLE'),
        *({'as': who, 'do': 'tm.task.note', 'data': {'id': '${task:PRIVATE E TITLE}', 'note': 'Guessed ID'}} for who in (B, C, D, X, Y)),
        task(E, 'Workspace D Dispatch', 'Dispatch work'),
        {'as': B, 'do': 'tm.task.progress', 'data': {'id': '${task:Dispatch work}', 'progress': 50}},
        {'as': A, 'do': 'tm.task.close', 'data': {'id': '${task:Dispatch work}'}},
        task(C, 'Workspace C Delivery', 'Outside participant', pic_id=Y, supporter_ids=[E]),
        *reads(*everyone),
        # Sharing a Personal workspace is up to its owner and makes it Public.
        {'as': A, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Private E workspace}', 'beneficiary_id': A, 'reason': 'Admin tries sharing'}},
        {'as': E, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Private E workspace}', 'beneficiary_id': Y, 'reason': 'Owner shares'}},
        *reads(Y, views=('workspaces',)),
        {'as': E, 'do': 'org.membership.remove', 'data': {'workspace_id': '${ws:Private E workspace}', 'beneficiary_id': Y, 'reason': 'Owner revokes',
                                                           'expected_revision': REV}},
        # Rejected delegation, other branches, stale revisions.
        {'as': D, 'do': 'org.delegation.request', 'data': {'beneficiary_id': E, 'parent_grant_id': grant('D'), 'reason': 'Further owner'}},
        {'as': B, 'do': 'org.request.decide', 'data': {'id': last_request('D'), 'decision': 'REJECT', 'note': 'Not required'}},
        {'as': D, 'do': 'org.delegation.request', 'data': {'beneficiary_id': Y, 'parent_grant_id': grant('D'), 'reason': 'Other branch'}},
        {'as': A, 'do': 'org.structure.save', 'data': {'changes': [{'staff_id': E, 'level': 5, 'manager_id': D}], 'expected_revision': 0,
                                                         'reason': 'Stale preview', 'acknowledged': True}},
        {'as': A, 'do': 'org.preview', 'data': {'changes': [{'staff_id': C, 'level': 3, 'manager_id': X}], 'expected_revision': REV}},
        # Revoking a grant needs replacement owners for its workspaces and suspends the grants below it.
        {'as': B, 'do': 'org.grant.revoke', 'data': {'id': grant('C'), 'reason': 'Revoke', 'expected_revision': REV, 'acknowledged': True}},
        {'as': B, 'do': 'org.grant.revoke', 'data': {'id': grant('C'), 'reason': 'Retire delegated workspaces', 'expected_revision': REV,
                                                       'acknowledged': True,
                                                       'workspace_replacements': [{'id': '${ws:Workspace C Delivery}', 'owner_id': B, 'governing_manager_id': B},
                                                                                  {'id': '${ws:Workspace D Dispatch}', 'owner_id': B, 'governing_manager_id': B}]}},
        # Branch moves: memberships across branches, transfer of a workspace, a team moving to another manager.
        {'as': B, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Workspace B Operations}', 'beneficiary_id': Y, 'reason': 'Cross branch work'}},
        {'as': A, 'do': 'org.workspace.save', 'data': {'id': '${ws:Workspace D Dispatch}', 'expected_version': '${version:tm_workspaces:@ws:Workspace D Dispatch}',
                                                         'expected_revision': REV, 'acknowledged': True, 'name': 'Workspace D Dispatch', 'kind': 'ORGANIZATIONAL',
                                                         'owner_id': X, 'governing_manager_id': X, 'reason': 'Transfer responsibility'}},
        {'as': X, 'do': 'org.membership.remove', 'data': {'workspace_id': '${ws:Workspace D Dispatch}', 'beneficiary_id': B,
                                                           'reason': 'End old independent membership', 'expected_revision': REV}},
        structure([(C, 3, X)], reason='Transfer team'),
        {'as': C, 'do': 'org.structure.request', 'data': {'changes': [{'staff_id': D, 'level': 4, 'manager_id': C}], 'expected_revision': REV,
                                                            'reason': 'Ask to keep D'}},
        {'as': C, 'do': 'org.request.cancel', 'data': {'id': last_request('C')}},
        {'as': Y, 'do': 'org.membership.request', 'data': {'workspace_id': '${ws:Workspace X Separate branch}', 'beneficiary_id': Y, 'reason': 'Outside join',
                                                            'request_key': 'notify-join'}},
        {'as': X, 'do': 'org.request.decide', 'data': {'id': last_request('Y'), 'decision': 'APPROVE'}},
        *({'as': who, 'do': 'org.workspace.classify', 'data': {'id': '${ws:Legacy warehouse}', 'kind': 'ORGANIZATIONAL', 'expected_revision': REV,
                                                                 'expected_version': '${version:tm_workspaces:@ws:Legacy warehouse}', 'acknowledged': True,
                                                                 'owner_id': B, 'governing_manager_id': B, 'reason': 'Warehouse team work'}}
          for who in (C, A, A)),
        *({'as': who, 'do': 'org.workspace.classify', 'data': {'id': '${ws:Legacy notes}', 'kind': 'PERSONAL', 'expected_revision': REV,
                                                                 'expected_version': '${version:tm_workspaces:@ws:Legacy notes}', 'acknowledged': True,
                                                                 'reason': 'My own notes', **extra}}
          for who, extra in ((A, {'shared_member_ids': []}), (E, {}), (E, {'shared_member_ids': [Y]}))),
        {'as': B, 'do': 'org.workspace.delete', 'data': {'id': '${ws:Workspace B Operations}', 'reason': 'Closing', 'expected_version':
                                                         '${version:tm_workspaces:@ws:Workspace B Operations}'}},
        {'as': B, 'do': 'org.workspace.delete', 'data': {'id': '${ws:Workspace B Operations}', 'reason': 'Closing', 'acknowledged': True,
                                                         'expected_version': '${version:tm_workspaces:@ws:Workspace B Operations}'}},
        {'as': B, 'do': 'tm.task.save', 'data': {'workspace_id': '${ws:Workspace B Operations}', 'title': 'After delete', 'start_date': '${today}',
                                                   'due_date': '${today:1}', 'pic_id': B, 'description': 'Should be refused'}},
        *reads(B, C, views=('workspaces', 'audit')),
        {'as': C, 'do': 'org.workspace.restore', 'data': {'id': '${ws:Workspace B Operations}', 'reason': 'Reopened', 'acknowledged': True,
                                                          'expected_version': '${version:tm_workspaces:@ws:Workspace B Operations}'}},
        {'as': B, 'do': 'org.workspace.restore', 'data': {'id': '${ws:Workspace B Operations}', 'reason': 'Reopened', 'acknowledged': True,
                                                          'expected_version': '${version:tm_workspaces:@ws:Workspace B Operations}'}},
        {'as': A, 'do': 'org.template.save', 'data': {'id': 'OWNER', 'name': 'Executive Director', 'capabilities': [], 'expected_revision': REV}},
        {'as': A, 'do': 'org.structure.save', 'data': {'changes': [{'staff_id': E, 'level': 1, 'manager_id': None}], 'expected_revision': REV,
                                                         'acknowledged': True, 'reason': 'Assign organization administrator explicitly'}},
        *reads(*everyone),
        *({'read': 'org', 'as': w, 'input': {'view': 'employee', 'staff_id': C}} for w in (A, B, X, Y)),
        {'read': 'org', 'as': A, 'input': {'parent': 'root'}}, {'read': 'org', 'as': A, 'input': {'q': 'member', 'limit': 2, 'page': 2}},
        {'read': 'org', 'as': A, 'input': {'view': 'audit', 'employee': C}},
    ]
    return steps


INSTANT = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z')


def scrub(value):
    """Audit rows keep before/after snapshots as JSON text, with the moment of the change inside."""
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return INSTANT.sub('<t>', value) if isinstance(value, str) else value


def test_organizational_structure_matches_v577(db):
    from tests.test_parity import legacy_mini_contract, management_contract
    steps = scenario()
    expected, actual = scrub(node_run({'steps': steps})), scrub(Scenario().play({'steps': steps}))
    assert len(expected['steps']) == len(actual['steps'])
    for i, (want, got) in enumerate(zip(expected['steps'], actual['steps'])):
        want, got = unvolatile(as_deployed(want)), unvolatile(management_contract(steps[i], legacy_mini_contract(steps[i], got)))
        if want != got:
            if want.get('ok') and got.get('ok') and isinstance(want['result'], dict) and isinstance(got['result'], dict):
                w, g = want['result'], got['result']
                keys = [k for k in sorted(set(w) | set(g)) if w.get(k, '<missing>') != g.get(k, '<missing>')]
                detail = []
                for k in keys[:4]:
                    a, b = w.get(k, '<missing>'), g.get(k, '<missing>')
                    if isinstance(a, list) and isinstance(b, list):
                        pair = next(((x, y) for x, y in zip(a, b) if x != y), (f'{len(a)} rows', f'{len(b)} rows'))
                        a, b = pair
                    detail.append(f'  {k}:\n   V5.7.7: {json.dumps(a, ensure_ascii=False)[:1500]}\n   Django: {json.dumps(b, ensure_ascii=False)[:1500]}')
                pytest.fail(f'step {i} {json.dumps(steps[i], ensure_ascii=False)[:300]}: keys differ {keys}\n' + '\n'.join(detail))
            pytest.fail(f'step {i} {json.dumps(steps[i], ensure_ascii=False)[:300]}\n V5.7.7: {json.dumps(want, ensure_ascii=False)[:2000]}\n'
                        f' Django: {json.dumps(got, ensure_ascii=False)[:2000]}')
    for table, want in expected['dump'].items():
        got = actual['dump'][table]
        if got != want:
            first = next(((a, b) for a, b in zip(want, got) if a != b), (want[len(got):][:1], got[len(want):][:1]))
            pytest.fail(f'{table}: V5.7.7 {len(want)} rows, Django {len(got)}\n V5.7.7: {json.dumps(first[0], ensure_ascii=False)}\n'
                        f' Django: {json.dumps(first[1], ensure_ascii=False)}')
