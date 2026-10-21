"""Background work the V5.7.7 server did on timers (server.mjs), run by `python manage.py run_workers`:

* due date reminders — 15 seconds after start, then every 10 minutes;
* meeting and calendar-note reminders — every minute;
* the Telegram bot — started, restarted and stopped as Administration → Telegram changes.

Each reminder pass runs in one transaction (V5.7.7 BEGIN IMMEDIATE … COMMIT) and every reminder is recorded, so a pass
that runs twice — two workers, or a restart — never notifies anyone twice.
"""
import logging
import threading

from django.db import close_old_connections, transaction

from core.services import changed, write_lock

log = logging.getLogger(__name__)


def due_reminders(at=None):
    from organization.governance import Governance
    from tasks.services import TaskService
    with transaction.atomic():
        write_lock()
        n = TaskService(Governance()).due_reminders(at)
        if n:
            changed()
    return n


def event_reminders(at=None):
    from meetings.services import MeetingService
    from organization.governance import Governance
    from tasks.services import TaskService
    with transaction.atomic():
        write_lock()
        n = MeetingService(TaskService(Governance())).event_reminders(at)
        if n:
            changed()
    return n


class Workers:
    def __init__(self, telegram=True, first_reminders=15, reminder_every=600, event_every=60):
        self.telegram, self.first, self.every, self.event_every = telegram, first_reminders, reminder_every, event_every
        self.stopped = threading.Event()
        self.runtime = None

    def _loop(self, name, job, first, every):
        def run():
            wait = first
            while not self.stopped.wait(wait):
                wait = every
                close_old_connections()
                try:
                    job()
                except Exception:   # noqa: BLE001 - logged; the next pass tries again (V5.7.7 warns and carries on)
                    log.exception('%s failed', name)
        thread = threading.Thread(target=run, name=name, daemon=True)
        thread.start()
        return thread

    def start(self):
        threads = [self._loop('due-reminders', due_reminders, self.first, self.every),
                   self._loop('calendar-reminders', event_reminders, self.event_every, self.event_every)]
        if self.telegram:
            from groups.delivery import process_next
            from core.document_capacity import capacity
            for index in range(capacity()['workers']):
                threads.append(self._loop(f'document-delivery-{index + 1}', process_next, 2 + index * .25, 2))
            from telegram import services as tg
            from telegram.bot import Runtime
            self.runtime = Runtime(app_url=lambda: tg.app_url())
            threads.append(threading.Thread(target=self.runtime.run, name='telegram-runtime', daemon=True))
            threads[-1].start()
        return threads

    def stop(self):
        self.stopped.set()
        if self.runtime:
            self.runtime.stopped.set()
