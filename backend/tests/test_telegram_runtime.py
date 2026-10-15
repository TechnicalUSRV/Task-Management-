"""Telegram bot plumbing: the HTTP transport to the Bot API, the supervisor that starts and stops the bot, the text
parsers (checked against V5.7.7), and the background workers command."""
import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from django.core.management import call_command

from telegram import bot as tgbot

SOURCE = Path(__file__).parent.parent.parent / 'source' / 'local-test'
TOKEN = '123456789:AAEhBOweik9ai_k4Mn-WQs8xa1bq6fGwhQo'


class FakeTelegram(BaseHTTPRequestHandler):
    """A local stand-in for api.telegram.org that records requests and answers like Telegram does."""
    seen = []

    def log_message(self, *args):
        pass

    def _answer(self, status, body):
        raw = json.dumps(body).encode() if not isinstance(body, bytes) else body
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.endswith('/big.bin'):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'x' * (tgbot.MAX_FILE + 10))
            return
        self._answer(200, b'file-bytes')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        method = self.path.rsplit('/', 1)[-1]
        FakeTelegram.seen.append((method, self.headers.get('Content-Type'), body))
        if method == 'getMe':
            return self._answer(200, {'ok': True, 'result': {'id': 1, 'username': 'sunny_test_bot', 'first_name': 'Sunny'}})
        if method == 'busy':
            return self._answer(429, {'ok': False, 'error_code': 429, 'description': 'Too Many Requests', 'parameters': {'retry_after': 3}})
        if method == 'moved':
            return self._answer(400, {'ok': False, 'error_code': 400, 'description': 'group upgraded', 'parameters': {'migrate_to_chat_id': -100777}})
        if method == 'broken':
            return self._answer(502, b'<html>Bad gateway</html>')
        return self._answer(200, {'ok': True, 'result': {'message_id': 7}})


@pytest.fixture
def fake_telegram():
    FakeTelegram.seen = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), FakeTelegram)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_address[1]}'
    server.shutdown()


def test_http_transport_talks_to_the_bot_api(fake_telegram):
    t = tgbot.http_transport(fake_telegram, TOKEN)
    assert t['call']('getMe', {})['username'] == 'sunny_test_bot'
    assert t['call']('sendMessage', {'chat_id': 5, 'text': 'សួស្តី <b>hi</b>'}) == {'message_id': 7}
    method, kind, body = FakeTelegram.seen[-1]
    assert method == 'sendMessage' and kind == 'application/json' and json.loads(body)['text'] == 'សួស្តី <b>hi</b>'
    with pytest.raises(tgbot.TelegramError) as busy:
        t['call']('busy', {})
    assert (busy.value.code, busy.value.retry_after) == (429, 3)
    with pytest.raises(tgbot.TelegramError) as moved:
        t['call']('moved', {'chat_id': -5})
    assert moved.value.migrate_to == -100777
    with pytest.raises(tgbot.TelegramError) as broken:
        t['call']('broken', {})
    assert broken.value.code == 502 and 'HTTP 502' in str(broken.value)
    assert t['download']('documents/a.pdf') == b'file-bytes'
    with pytest.raises(tgbot.TelegramError) as big:
        t['download']('documents/big.bin')
    assert big.value.too_large
    assert t['upload']('sendDocument', 5, 'document', {'content': b'%PDF-1.4', 'mime': 'application/pdf', 'name': 'count sheet.pdf'},
                       {'caption': 'count sheet.pdf · TASK-000001'}) == {'message_id': 7}
    method, kind, body = FakeTelegram.seen[-1]
    assert kind.startswith('multipart/form-data; boundary=')
    assert b'name="chat_id"\r\n\r\n5\r\n' in body and b'filename="count%20sheet.pdf"' in body and b'%PDF-1.4' in body
    with pytest.raises(tgbot.TelegramError):
        tgbot.http_transport('http://127.0.0.1:9', TOKEN)['call']('getMe', {}, timeout=2)


def test_call_retries_once_after_a_short_flood_wait(monkeypatch):
    sleeps, attempts = [], []

    def call(method, params, timeout=15):
        attempts.append(params.get('chat_id'))
        if len(attempts) == 1:
            raise tgbot.TelegramError('Too Many Requests', 429, retry_after=2)
        return {'message_id': 1}
    monkeypatch.setattr(tgbot.time, 'sleep', sleeps.append)
    bot = tgbot.Bot(TOKEN, transport={'call': call})
    assert bot.call('sendMessage', {'chat_id': 5}) == {'message_id': 1}
    assert sleeps == [2] and attempts == [5, 5]


def test_runtime_follows_the_telegram_settings(db, monkeypatch):
    from telegram.models import TelegramSettings
    started = []
    monkeypatch.setattr(tgbot.Bot, 'start', lambda self: started.append(self.token) or self)
    runtime = tgbot.Runtime(app_url=lambda: 'https://tasks.example.test/c/default/tg/')
    runtime.supervise()
    assert runtime.bot is None and started == []
    TelegramSettings.objects.filter(id=1).update(enabled=True, bot_token=TOKEN)
    runtime.supervise()
    first = runtime.bot
    assert started == [TOKEN] and first.app_url() == 'https://tasks.example.test/c/default/tg/'
    runtime.supervise()
    assert runtime.bot is first and started == [TOKEN]
    TelegramSettings.objects.filter(id=1).update(bot_token='987654321:' + 'b' * 35)
    runtime.supervise()
    assert first.stopped.is_set() and runtime.bot is not first and len(started) == 2
    TelegramSettings.objects.filter(id=1).update(enabled=False, status='ONLINE')
    second = runtime.bot
    runtime.supervise()
    assert runtime.bot is None and second.stopped.is_set()
    assert TelegramSettings.objects.get(id=1).status == 'OFF'


def test_rejected_token_stops_the_bot(db):
    from telegram.models import TelegramSettings

    def call(method, params, timeout=15):
        raise tgbot.TelegramError('Unauthorized', 401)
    bot = tgbot.Bot(TOKEN, transport={'call': call})
    bot.run()
    s = TelegramSettings.objects.get(id=1)
    assert s.status == 'ERROR' and 'rejected the bot token' in s.status_detail


TEXTS = ['/start', '/start link_ABCD2345', '/menu@sunny_test_bot', '/menu@Sunny_Test_Bot extra words', '/menu@other_bot', '/x' * 20,
         '/newtask  Count   the store ', 'hello', '/', '/a_b_c_d@bot 1\n2', '/ünicode']
DAYS = ['today', 'Tomorrow', '+3', '+12 days', '+999', '+1000', '2026-10-05', '2026-2-30', '2026-02-28', '5/10', '05.10.2026', '31-12-26', '29/2',
        '1/1', '32/1', 'next week', '', '  7/11  ']


@pytest.mark.skipif(not shutil.which('node') or not (SOURCE / 'telegram-bot.mjs').exists(), reason='Node.js and the V5.7.7 sources are needed')
def test_parsers_match_v577():
    script = ("import {parseCommand,parseDay} from " + json.dumps((SOURCE / 'telegram-bot.mjs').as_uri()) + ";"
              "const [texts,days]=JSON.parse(process.argv[1]);"
              "console.log(JSON.stringify({commands:texts.map(t=>parseCommand(t,'sunny_test_bot')??null),days:days.map(d=>parseDay(d))}));")
    done = subprocess.run(['node', '--no-warnings', '--input-type=module', '-e', script, json.dumps([TEXTS, DAYS])],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    expected = json.loads(done.stdout)
    assert [tgbot.parse_command(t, 'sunny_test_bot') for t in TEXTS] == expected['commands']
    assert [tgbot.parse_day(d) for d in DAYS] == expected['days']


def test_workers_send_reminders_once(db, capsys):
    call_command('run_workers', '--once')
    assert 'Reminders sent: 0 due date, 0 calendar.' in capsys.readouterr().out
