"""The Telegram bot matches V5.7.7: the same conversation runs against the original telegram-bot.mjs and the Django port.

The Bot API is replaced by a recorder on both sides, so each step compares every message, edit, button and answer the
bot sends (text, keyboards, reply markup and order), and the stored rows afterwards (tasks, notifications, deliveries,
Telegram links, groups and conversation steps). Needs Node.js 22.5+ and the V5.7.7 sources, like the other parity tests.
"""
import itertools

from tests.test_parity import DARA, KOSAL, SOPHEA, compare, legacy_workspace, people
from tests.test_parity import pytestmark as needs_node

pytestmark = needs_node  # skipped without Node.js and the V5.7.7 sources

TOKEN = '123456:TEST-token_abcdefghijklmnopqrstuvwxyz'
USERS = {'ADMIN': 5000, 'SOPHEA': 5002, 'DARA': 5001, 'KOSAL': 5003, 'STRANGER': 6000}
GROUP = -1001234567890
counter = itertools.count(1)


def sender(who):
    return {'id': USERS[who], 'is_bot': False, 'first_name': who.title(), **({'username': who.lower()} if who != 'KOSAL' else {})}


def chat(who, group=False):
    return ({'id': GROUP, 'type': 'supergroup', 'title': 'Operations team'} if group
            else {'id': USERS[who], 'type': 'private', 'first_name': who.title()})


def msg(who, text, group=False, reply_to=None, **extra):
    n = next(counter)
    m = {'message_id': 10_000 + n, 'from': sender(who), 'chat': chat(who, group), 'date': 0, 'text': text, **extra}
    if reply_to is not None:
        m['reply_to_message'] = {'message_id': reply_to, 'from': {'id': 999, 'is_bot': True, 'first_name': 'Sunny'}, 'chat': chat(who, group), 'date': 0,
                                 'text': '…'}
    return {'tg': {'update_id': n, 'message': m}}


def cb(who, data, message_id='${sent}', group=False):
    n = next(counter)
    return {'tg': {'update_id': n, 'callback_query': {'id': f'cb{n}', 'from': sender(who), 'chat_instance': 'x', 'data': data,
                                                      'message': {'message_id': message_id, 'chat': chat(who, group), 'date': 0, 'text': '…'}}}}


def card(who):
    return f'${{card:{USERS[who]}}}'


TASK = '${task:Count the main store}'
REQUEST = '${request:New shelving quote}'


def conversation():
    base = len(people())
    steps = people() + [legacy_workspace(), {'telegram_bot': TOKEN}, {'tg_flush': {}}]
    codes = {}
    for who, staff in (('DARA', DARA), ('SOPHEA', SOPHEA), ('KOSAL', KOSAL)):
        codes[who] = len(steps)
        steps.append({'as': staff, 'do': 'tg.link.code', 'data': {}})
    steps += [
        msg('STRANGER', '/start'),
        msg('STRANGER', 'hello'),
        msg('DARA', f"/start link_${{{codes['DARA']}.code}}"),
        msg('SOPHEA', f"${{{codes['SOPHEA']}.code}}"),
        msg('KOSAL', f"/link ${{{codes['KOSAL']}.code}}"),
        msg('KOSAL', '/link ABCD2345'),
        msg('DARA', '/help'),
        msg('DARA', '/menu'),
        msg('DARA', 'what now?'),
        msg('DARA', '/nonsense'),
        msg('DARA', '/cancel'),
        # Sophea creates a task for Dara with Kosal supporting, entirely from Telegram.
        msg('SOPHEA', '/newtask'),
        msg('SOPHEA', 'Count the main store'),
        cb('SOPHEA', f'f:pic:{DARA}', card('SOPHEA')),
        cb('SOPHEA', 'f:due:3', card('SOPHEA')),
        cb('SOPHEA', 'f:edit:supporters', card('SOPHEA')),
        cb('SOPHEA', f'f:sup:{KOSAL}', card('SOPHEA')),
        cb('SOPHEA', f'f:sup:{SOPHEA}', card('SOPHEA')),
        cb('SOPHEA', f'f:sup:{SOPHEA}', card('SOPHEA')),
        cb('SOPHEA', 'f:sup:done', card('SOPHEA')),
        cb('SOPHEA', 'f:edit:priority', card('SOPHEA')),
        cb('SOPHEA', 'f:pri:HIGH', card('SOPHEA')),
        cb('SOPHEA', 'f:text:department_note', card('SOPHEA')),
        msg('SOPHEA', 'Warehouse team'),
        cb('SOPHEA', 'f:ok', card('SOPHEA')),
        msg('SOPHEA', '   '),
        cb('SOPHEA', 'f:ok', card('SOPHEA')),
        msg('SOPHEA', 'Every shelf counted and reconciled with the system.'),
        cb('SOPHEA', 'f:ok', 777),
        cb('SOPHEA', 'f:ok', card('SOPHEA')),
        {'tg_flush': {}},
        # Dara and Kosal answer from their notifications.
        cb('DARA', f't:v:{TASK}'),
        cb('DARA', f't:acc:{TASK}'),
        cb('KOSAL', f't:dec:{TASK}'),
        msg('KOSAL', '/skip'),
        msg('KOSAL', 'Busy with the audit'),
        cb('KOSAL', f't:acc:{TASK}'),
        msg('DARA', '/answer'),
        msg('DARA', '/mytasks'),
        msg('KOSAL', '/supporting'),
        cb('DARA', f't:prg:{TASK}'),
        cb('DARA', f't:p:{TASK}:50'),
        cb('DARA', f't:p:{TASK}:500'),
        {'tg_flush': {}},
        cb('SOPHEA', 'c:ok:${change:@task:Count the main store}'),
        cb('DARA', f't:po:{TASK}'),
        msg('DARA', 'about sixty'),
        msg('DARA', '60'),
        cb('DARA', 'c:wd:${change:@task:Count the main store}'),
        cb('DARA', f't:p:{TASK}:75'),
        {'tg_flush': {}},
        cb('KOSAL', 'c:no:${change:@task:Count the main store}'),
        cb('SOPHEA', 'c:no:${change:@task:Count the main store}'),
        msg('SOPHEA', '/cancel'),
        cb('SOPHEA', 'c:no:${change:@task:Count the main store}'),
        msg('SOPHEA', 'Not yet, recount aisle 2'),
        cb('DARA', f't:stk:{TASK}'),
        msg('DARA', 'Scanner broken'),
        cb('DARA', f't:res:{TASK}'),
        cb('DARA', f't:note:{TASK}'),
        msg('DARA', 'Halfway through aisle 4'),
        cb('DARA', f't:ck:{TASK}'),
        cb('DARA', f'k:add:{TASK}'),
        msg('DARA', 'Print the count sheets'),
        cb('DARA', f'k:add:{TASK}'),
        msg('DARA', 'Reconcile'),
        cb('DARA', 'k:t:${step:1:@task:Count the main store}'),
        cb('DARA', f't:due:{TASK}'),
        msg('DARA', 'next blue moon'),
        msg('DARA', '+5'),
        msg('DARA', 'Supplier is late'),
        {'tg_flush': {}},
        cb('KOSAL', 'd:v:${due:@task:Count the main store}'),
        cb('SOPHEA', 'd:v:${due:@task:Count the main store}'),
        cb('SOPHEA', 'd:ok:${due:@task:Count the main store}'),
        cb('SOPHEA', 'c:ok:${change:@task:Count the main store}'),
        cb('DARA', f't:fl:{TASK}'),
        cb('DARA', f'a:add:{TASK}'),
        msg('DARA', 'not a file'),
        {'tg': {'update_id': next(counter), 'message': {'message_id': 20_001, 'from': sender('DARA'), 'chat': chat('DARA'), 'date': 0,
                                                         'document': {'file_id': 'DOC1', 'file_unique_id': 'u1', 'file_name': 'count-sheet.pdf',
                                                                      'mime_type': 'application/pdf', 'file_size': 12}}}},
        {'tg': {'update_id': next(counter), 'message': {'message_id': 20_002, 'from': sender('KOSAL'), 'chat': chat('KOSAL'), 'date': 0,
                                                         'document': {'file_id': 'DOC2', 'file_unique_id': 'u2', 'file_name': 'big.zip',
                                                                      'mime_type': 'application/zip', 'file_size': 40_000_000},
                                                         'reply_to_message': {'message_id': 1, 'from': {'id': 999, 'is_bot': True, 'first_name': 'Sunny'},
                                                                              'chat': chat('KOSAL'), 'date': 0, 'text': f'Task {TASK} was updated'}}}},
        cb('DARA', f'a:add:{TASK}'),
        {'tg': {'update_id': next(counter), 'message': {'message_id': 20_003, 'from': sender('DARA'), 'chat': chat('DARA'), 'date': 0,
                                                         'document': {'file_id': 'IMG1', 'file_unique_id': 'u3', 'file_name': 'shelf.png',
                                                                      'mime_type': 'image/png', 'file_size': 70}}}},
        cb('DARA', 'a:g:${file:@task:Count the main store}'),
        cb('KOSAL', 'a:g:${file:@task:Count the main store}'),
        cb('DARA', f't:sub:{TASK}'),
        msg('DARA', '/skip'),
        {'tg_flush': {}},
        msg('SOPHEA', '/review'),
        cb('SOPHEA', f't:cls:{TASK}'),
        cb('SOPHEA', f't:cls!:{TASK}'),
        {'tg_flush': {}},
        cb('DARA', f't:v:{TASK}'),
        # Requests: Dara asks Sophea for a task; Sophea approves it from Telegram.
        msg('DARA', '/request New shelving quote'),
        cb('DARA', 'f:pg:mgr:1', card('DARA')),
        cb('DARA', f'f:mgr:{SOPHEA}', card('DARA')),
        cb('DARA', 'f:doer:RECEIVER', card('DARA')),
        cb('DARA', 'f:ws:-', card('DARA')),
        cb('DARA', 'f:due:other', card('DARA')),
        msg('DARA', '31/2'),
        msg('DARA', '2020-01-01'),
        msg('DARA', '+7'),
        cb('DARA', 'f:text:description', card('DARA')),
        msg('DARA', 'Three quotes for the new shelving.'),
        cb('DARA', 'f:ok', card('DARA')),
        msg('DARA', '/requests'),
        {'tg_flush': {}},
        cb('SOPHEA', f'r:v:{REQUEST}'),
        cb('KOSAL', f'r:v:{REQUEST}'),
        cb('SOPHEA', f'r:ok:{REQUEST}'),
        cb('SOPHEA', f'f:ws:${{{base}.id}}', card('SOPHEA')),
        cb('SOPHEA', 'f:edit:pic', card('SOPHEA')),
        cb('SOPHEA', f'f:pic:{SOPHEA}', card('SOPHEA')),
        cb('SOPHEA', 'f:ok', card('SOPHEA')),
        {'tg_flush': {}},
        msg('DARA', '/menu'),
        cb('SOPHEA', 't:ho:${task:New shelving quote}'),
        cb('SOPHEA', 't:hop:${task:New shelving quote}:1'),
        cb('SOPHEA', f't:hp:${{task:New shelving quote}}:{KOSAL}'),
        cb('SOPHEA', f't:hx:${{task:New shelving quote}}:{KOSAL}:1'),
        {'tg_flush': {}},
        cb('KOSAL', 't:acc:${task:New shelving quote}'),
        cb('SOPHEA', 't:rm:${task:New shelving quote}'),
        cb('KOSAL', 't:can:${task:New shelving quote}'),
        cb('SOPHEA', 't:can:${task:New shelving quote}'),
        msg('SOPHEA', 'No budget this quarter'),
        {'tg_flush': {}},
        msg('SOPHEA', '/report'),
        cb('SOPHEA', 'rep:me:${month}:completed'),
        cb('SOPHEA', 'rep:all:${month}'),
        cb('DARA', 'rep:all:${month}:stuck'),
        cb('DARA', 'rep:me:2099-01'),
        msg('DARA', f'/task {TASK}'),
        msg('DARA', '/task NOPE-1'),
        # A group: the bot is added, Sophea links it to the workspace, people use it there.
        {'tg': {'update_id': next(counter), 'my_chat_member': {'chat': chat('SOPHEA', True), 'from': sender('SOPHEA'), 'date': 0,
                                                                'old_chat_member': {'status': 'left', 'user': {'id': 999, 'is_bot': True, 'first_name': 'Sunny'}},
                                                                'new_chat_member': {'status': 'member', 'user': {'id': 999, 'is_bot': True, 'first_name': 'Sunny'}}}}},
        msg('DARA', '/tasks', True),
        msg('DARA', '/connect', True),
        msg('SOPHEA', '/connect@sunny_test_bot', True),
        msg('SOPHEA', '/connect@other_bot', True),
        cb('SOPHEA', f'g:ws:${{{base}.id}}', group=True),
        msg('STRANGER', '/tasks', True),
        msg('DARA', '/tasks', True),
        msg('KOSAL', '/mytasks', True),
        msg('DARA', '/help', True),
        msg('SOPHEA', '/report', True),
        msg('DARA', '/newtask', True),
        msg('KOSAL', 'Fix the loading dock door', True),
        msg('DARA', 'Fix the loading dock door', True, reply_to='${sent}'),
        msg('SOPHEA', '/disconnect', True),
        cb('SOPHEA', 'g:off:-', group=True),
        # Blocked bot: the next notification to Dara fails with 403 and pauses her messages.
        {'as': SOPHEA, 'do': 'tm.task.reopen', 'data': {'id': TASK, 'reason': 'One shelf was missed'}},
        {'tg_fail': {'method': 'sendMessage', 'code': 403, 'description': 'Forbidden: bot was blocked by the user'}},
        {'tg_flush': {}},
        {'tg_flush': {'digest': True}},
        msg('DARA', '/start'),
        msg('KOSAL', '/unlink'),
        cb('KOSAL', 'u:no'),
        cb('KOSAL', 'u:yes'),
        msg('KOSAL', '/menu'),
    ]
    return steps


def test_bot_conversation_matches_v577(db):
    compare({'steps': conversation()}, volatile=('code', 'link'))
