"""Runs the background work of Task Management next to the web server: due date and calendar reminders and the
Telegram bot. Start it once per company database (one bot may poll Telegram per bot token):

    python manage.py run_workers            # keeps running; stop with Ctrl+C
    python manage.py run_workers --once     # one reminder pass, then exit (for a scheduler such as Windows Task Scheduler)
    python manage.py run_workers --no-telegram
"""
import signal
import threading

from django.core.management.base import BaseCommand

from core import workers


class Command(BaseCommand):
    help = 'Run due date reminders, calendar reminders and the Telegram bot.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true', help='Run one pass of due date and calendar reminders, then exit.')
        parser.add_argument('--no-telegram', action='store_true', help='Do not run the Telegram bot.')

    def handle(self, *args, **options):
        if options['once']:
            due, events = workers.due_reminders(), workers.event_reminders()
            self.stdout.write(f'Reminders sent: {due} due date, {events} calendar.')
            return
        w = workers.Workers(telegram=not options['no_telegram'])
        done = threading.Event()

        def stop(*_):
            done.set()
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        w.start()
        self.stdout.write('Workers running: due date reminders (every 10 minutes), calendar reminders (every minute)'
                          + ('' if options['no_telegram'] else ', Telegram bot (when turned on in Administration → Telegram)') + '. Press Ctrl+C to stop.')
        while not done.wait(1):
            pass
        w.stop()
        self.stdout.write('Workers stopped.')
