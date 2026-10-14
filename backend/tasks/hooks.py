"""What other apps need to know about tasks (registered in core.hooks, see TasksConfig.ready)."""
from core import hooks

from .models import Task, TaskAssignee, TaskRequest

CLOSED = ('COMPLETED', 'CANCELLED')


def workspace_people(wid):
    """People with open tasks or pending task requests in a workspace (organization.mjs removeWorkspace, V5.6.8)."""
    open_tasks = Task.objects.filter(workspace_id=wid).exclude(status__in=CLOSED)
    people = []
    for column in ('pic_id', 'reviewer_id', 'assigned_by_id'):
        people += [s for s in open_tasks.values_list(column, flat=True) if s]
    people += list(TaskAssignee.objects.filter(task__workspace_id=wid).exclude(status='DECLINED').exclude(task__status__in=CLOSED)
                   .values_list('staff_id', flat=True))
    pending = TaskRequest.objects.filter(workspace_id=wid, status='PENDING')
    people += [s for s in pending.values_list('requested_by_id', flat=True) if s]
    people += [s for s in pending.values_list('manager_id', flat=True) if s]
    return list(dict.fromkeys(people))


def workspace_open_tasks(wid):
    return Task.objects.filter(workspace_id=wid).exclude(status__in=CLOSED).exists()


def member_open_tasks(wid, staff):
    return TaskAssignee.objects.filter(task__workspace_id=wid, staff_id=staff).exclude(status='DECLINED').exclude(task__status__in=CLOSED).exists()


def workspace_task_count(wid):
    return Task.objects.filter(workspace_id=wid).count()


def register():
    for collection, function in ((hooks.WORKSPACE_PEOPLE, workspace_people), (hooks.WORKSPACE_OPEN_WORK, workspace_open_tasks),
                                 (hooks.MEMBER_OPEN_WORK, member_open_tasks), (hooks.WORKSPACE_TASK_COUNT, workspace_task_count)):
        if function not in collection:
            collection.append(function)

