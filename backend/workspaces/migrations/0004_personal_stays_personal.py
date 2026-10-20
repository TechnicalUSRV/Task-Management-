"""Personal workspaces stay Personal when members are added.

Migration 0002 created a database trigger that turned a PERSONAL workspace PUBLIC as soon as someone other than its
owner became a member. That rule is retired: an owner may now share a Personal workspace with selected members, and it
becomes Public only through the owner's explicit visibility change (which the remaining `workspace_public_audit`
trigger still records in org_audit).

Only the conversion trigger is dropped. Existing rows are not changed: workspaces that were converted earlier stay
Public, and the org_audit append-only trigger and the Public audit trigger are kept. Reversing this migration recreates
the conversion trigger exactly as 0002 defined it (it acts on later membership writes only).
"""
from django.db import migrations

MSSQL_DROP = ['DROP TRIGGER IF EXISTS dbo.workspace_member_public']
MSSQL_CREATE = ["""
CREATE TRIGGER dbo.workspace_member_public ON dbo.tm_members AFTER INSERT, UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted) AND NOT (UPDATE(workspace_id) OR UPDATE(staff_id)) RETURN;
    UPDATE w SET visibility = 'PUBLIC', version = w.version + 1, updated_at = SYSUTCDATETIME()
    FROM dbo.tm_workspaces w
    WHERE w.visibility = 'PERSONAL'
      AND EXISTS (SELECT 1 FROM inserted i WHERE i.workspace_id = w.id AND i.staff_id <> w.owner_id);
END
"""]

_CONVERT = ("UPDATE tm_workspaces SET visibility='PUBLIC', version=version+1, "
            "updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE id=NEW.workspace_id AND visibility='PERSONAL' AND owner_id<>NEW.staff_id;")
SQLITE_DROP = ['DROP TRIGGER IF EXISTS workspace_member_public_insert', 'DROP TRIGGER IF EXISTS workspace_member_public_update']
SQLITE_CREATE = [f'CREATE TRIGGER workspace_member_public_insert AFTER INSERT ON tm_members BEGIN {_CONVERT} END',
                 f'CREATE TRIGGER workspace_member_public_update AFTER UPDATE OF workspace_id, staff_id ON tm_members BEGIN {_CONVERT} END']


def run(statements):
    def apply(apps, schema_editor):
        vendor = schema_editor.connection.vendor
        chosen = statements['mssql'] if vendor == 'microsoft' else statements['sqlite'] if vendor == 'sqlite' else None
        if chosen is None:
            raise RuntimeError(f'Unsupported database vendor for workspace triggers: {vendor}')
        for sql in chosen:
            schema_editor.execute(sql)
    return apply


class Migration(migrations.Migration):
    dependencies = [('workspaces', '0003_workspace_managers')]
    operations = [migrations.RunPython(run({'mssql': MSSQL_DROP, 'sqlite': SQLITE_DROP}),
                                       run({'mssql': MSSQL_CREATE, 'sqlite': SQLITE_CREATE}))]
