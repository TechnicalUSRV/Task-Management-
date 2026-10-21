import json
from django.core.management.base import BaseCommand
from core.document_capacity import capacity


class Command(BaseCommand):
    help = 'Read-only CPU/RAM and document worker limit check. No Telegram calls or database changes.'

    def handle(self, *args, **options):
        self.stdout.write(json.dumps(capacity(), indent=2))
        self.stdout.write('Default: one slot. Measure SQL/web load before setting DOCUMENT_WORKERS=2 or more; the limit is capped at four.')
