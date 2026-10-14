"""Database rules ported from V5.7.7 (workspace-privacy.mjs, organization.sql).

1. Adding (or changing) a membership for someone other than the owner converts a PERSONAL workspace to PUBLIC in the
   same transaction; the conversion is written to org_audit and advances the organization revision. Enforced in the
   database so every writer — the API, imports, scripts — obeys it, and a failed command rolls it back with the rest.
2. org_audit is append-only: UPDATE and DELETE are refused.

SQL Server and SQLite versions are equivalent; SQLite is used only by the automated tests.
"""
from django.db import migrations

MSSQL = [
    """
CREATE TRIGGER dbo.workspace_member_public ON dbo.tm_members AFTER INSERT, UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted) AND NOT (UPDATE(workspace_id) OR UPDATE(staff_id)) RETURN;
    UPDATE w SET visibility = 'PUBLIC', version = w.version + 1, updated_at = SYSUTCDATETIME()
    FROM dbo.tm_workspaces w
    WHERE w.visibility = 'PERSONAL'
      AND EXISTS (SELECT 1 FROM inserted i WHERE i.workspace_id = w.id AND i.staff_id <> w.owner_id);
END
""",
    """
CREATE TRIGGER dbo.workspace_public_audit ON dbo.tm_workspaces AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    IF NOT UPDATE(visibility) RETURN;
    INSERT INTO dbo.org_audit (actor_id, action, employee_id, workspace_id, before_json, after_json, reason, approval_id, created_at)
    SELECT i.owner_id, 'workspace.public', NULL, i.id, '{"visibility":"PERSONAL"}', '{"visibility":"PUBLIC"}',
           'Personal workspace converted to Public', NULL, SYSUTCDATETIME()
    FROM inserted i JOIN deleted d ON d.id = i.id
    WHERE d.visibility = 'PERSONAL' AND i.visibility = 'PUBLIC';
    IF @@ROWCOUNT > 0 UPDATE dbo.org_settings SET revision = revision + 1 WHERE id = 1;
END
""",
    """
CREATE TRIGGER dbo.org_audit_append_only ON dbo.org_audit INSTEAD OF UPDATE, DELETE AS
BEGIN
    SET NOCOUNT ON;
    THROW 51000, 'Organization audit history is append-only', 1;
END
""",
]
MSSQL_REVERSE = [
    'DROP TRIGGER IF EXISTS dbo.org_audit_append_only',
    'DROP TRIGGER IF EXISTS dbo.workspace_public_audit',
    'DROP TRIGGER IF EXISTS dbo.workspace_member_public',
]

_CONVERT = ("UPDATE tm_workspaces SET visibility='PUBLIC', version=version+1, "
            "updated_at=strftime('%Y-%m-%d %H:%M:%f','now') "
            "WHERE id=NEW.workspace_id AND visibility='PERSONAL' AND owner_id<>NEW.staff_id;")
SQLITE = [
    f'CREATE TRIGGER workspace_member_public_insert AFTER INSERT ON tm_members BEGIN {_CONVERT} END',
    f'CREATE TRIGGER workspace_member_public_update AFTER UPDATE OF workspace_id, staff_id ON tm_members BEGIN {_CONVERT} END',
    """CREATE TRIGGER workspace_public_audit AFTER UPDATE OF visibility ON tm_workspaces
WHEN OLD.visibility='PERSONAL' AND NEW.visibility='PUBLIC' BEGIN
 INSERT INTO org_audit(actor_id,action,employee_id,workspace_id,before_json,after_json,reason,approval_id,created_at)
 VALUES(NEW.owner_id,'workspace.public',NULL,NEW.id,'{"visibility":"PERSONAL"}','{"visibility":"PUBLIC"}',
        'Personal workspace converted to Public',NULL,strftime('%Y-%m-%d %H:%M:%f','now'));
 UPDATE org_settings SET revision=revision+1 WHERE id=1;
END""",
    "CREATE TRIGGER org_audit_no_update BEFORE UPDATE ON org_audit BEGIN SELECT RAISE(ABORT,'Organization audit history is append-only'); END",
    "CREATE TRIGGER org_audit_no_delete BEFORE DELETE ON org_audit BEGIN SELECT RAISE(ABORT,'Organization audit history is append-only'); END",
]
SQLITE_REVERSE = [f'DROP TRIGGER IF EXISTS {name}' for name in (
    'org_audit_no_delete', 'org_audit_no_update', 'workspace_public_audit',
    'workspace_member_public_update', 'workspace_member_public_insert')]


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
    dependencies = [
        ('workspaces', '0001_initial'),
        ('organization', '0003_orgaudit_workspace_orggrant_beneficiary_and_more'),
    ]
    operations = [migrations.RunPython(run({'mssql': MSSQL, 'sqlite': SQLITE}),
                                       run({'mssql': MSSQL_REVERSE, 'sqlite': SQLITE_REVERSE}))]
