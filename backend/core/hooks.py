"""Extension points between apps, so lower layers never import higher ones.

TELEGRAM_UNLINK: (staff_id, actor_staff_id, why) — run when an account's password changes, the account is disabled or
    the person signs out everywhere. The telegram app registers its unlink function.
WORKSPACE_PEOPLE: (workspace_id) -> staff ids with open tasks, pending requests or scheduled meetings in a workspace
    (told when it is deleted or restored). Registered by the tasks and meetings apps.
WORKSPACE_OPEN_WORK: (workspace_id) -> True when it still has open tasks or scheduled meetings (archiving is refused).
MEMBER_OPEN_WORK: (workspace_id, staff_id) -> True when that member still has open assigned work or scheduled meetings
    in the workspace (they cannot be dropped from a legacy workspace's member list).
WORKSPACE_TASK_COUNT: (workspace_id) -> number of tasks (shown in the migration review).
"""
TELEGRAM_UNLINK = []
WORKSPACE_PEOPLE = []
WORKSPACE_OPEN_WORK = []
MEMBER_OPEN_WORK = []
WORKSPACE_TASK_COUNT = []
