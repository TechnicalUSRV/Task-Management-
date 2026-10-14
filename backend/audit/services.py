"""tasks.mjs log(): the Task Management activity history (tm_events).

V5.7.7 also copied each entry into the CRM customer journey (`events`). CRM is switched off in this deployment
(Stage 1 decision A), so only the Task Management history is written.
"""
from django.utils import timezone

from .models import ActivityEvent


def log(actor, entity_type, key, workspace_id, action, detail=''):
    ActivityEvent.objects.create(entity_type=entity_type, entity_id=key, workspace_id=workspace_id or None, action=action,
                                 detail=detail or '', actor_id=actor, created_at=timezone.now())
