"""What other apps need to know about meetings (registered in core.hooks, see MeetingsConfig.ready)."""
from core import hooks

from .models import Meeting, MeetingAttendee


def workspace_people(wid):
    """Attendees of the workspace's scheduled meetings (organization.mjs removeWorkspace, V5.6.8)."""
    return list(dict.fromkeys(MeetingAttendee.objects.filter(meeting__workspace_id=wid, meeting__status='SCHEDULED')
                              .order_by('id').values_list('staff_id', flat=True)))


def workspace_scheduled(wid):
    return Meeting.objects.filter(workspace_id=wid, status='SCHEDULED').exists()


def member_scheduled(wid, staff):
    return MeetingAttendee.objects.filter(meeting__workspace_id=wid, meeting__status='SCHEDULED', staff_id=staff).exists()


def register():
    for collection, function in ((hooks.WORKSPACE_PEOPLE, workspace_people), (hooks.WORKSPACE_OPEN_WORK, workspace_scheduled),
                                 (hooks.MEMBER_OPEN_WORK, member_scheduled)):
        if function not in collection:
            collection.append(function)
