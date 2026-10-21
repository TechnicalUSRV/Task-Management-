"""Task Management · Groups (V5.4–V5.6.9): customizable tables inside a workspace, with V5.7.7 table and column names.

Internally a Group is a "board", so it is never confused with team membership. Cell values are stored by stable column
ID in `values_json`; formulas are stored with column IDs and calculated on the server when rows are read (groups.domain).
Notes keep their edit and deletion history; rows and columns can be limited to people or roles; each person keeps their
own layout; Excel uploads are kept until imported (so a retried import never adds rows twice); files in Attachment
columns are kept in `tm_board_files`.

Deleting cascades as V5.7.7's `ON DELETE CASCADE` does (Django applies it). Groups are only deleted permanently by their
owner (or a group administrator) after they were archived, exactly as in V5.7.7.
"""
from django.db import models
from django.db.models import Q

from core.models import Staff
from workspaces.models import Workspace

VISIBILITIES = ['PERSONAL', 'TEAM']
AUDIENCES = ['WORKSPACE', 'SELECTED']
WORKSPACE_LEVELS = ['VIEW', 'EDIT']
ACCESS_LEVELS = ['VIEW', 'EDIT', 'MANAGE']
STATUSES = ['ACTIVE', 'ARCHIVED']
COLUMN_TYPES = ['TEXT', 'DATE', 'NUMBER', 'STATUS', 'IN_CHARGE', 'SUPPORT', 'FORMULA', 'ATTACHMENT', 'LINKED']
LIVE_PERMISSIONS = ['VIEW', 'EDIT']
PRINCIPALS = ['USER', 'ROLE']
NOTE_ACTIONS = ['EDIT', 'DELETE']
IMPORT_STATUSES = ['UPLOADED', 'IMPORTED']


def person(column, null=True):
    return models.ForeignKey(Staff, on_delete=models.PROTECT, null=null, blank=null, related_name='+', db_column=column)


class Board(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    workspace = models.ForeignKey(Workspace, on_delete=models.PROTECT, related_name='boards')
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default='')
    visibility = models.CharField(max_length=10)
    audience = models.CharField(max_length=10, default='SELECTED')
    workspace_level = models.CharField(max_length=10, default='EDIT')
    owner = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='owned_boards')
    status = models.CharField(max_length=10, default='ACTIVE')
    archived_at = models.DateTimeField(null=True, blank=True)
    archived_by = person('archived_by')
    version = models.IntegerField(default=0)
    created_by = person('created_by', null=False)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    layout_json = models.TextField(default='{}')

    class Meta:
        db_table = 'tm_boards'
        constraints = [
            models.CheckConstraint(condition=Q(visibility__in=VISIBILITIES), name='tm_board_visibility_valid'),
            models.CheckConstraint(condition=Q(audience__in=AUDIENCES), name='tm_board_audience_valid'),
            models.CheckConstraint(condition=Q(workspace_level__in=WORKSPACE_LEVELS), name='tm_board_level_valid'),
            models.CheckConstraint(condition=Q(status__in=STATUSES), name='tm_board_status_valid'),
        ]
        indexes = [models.Index(fields=['workspace', 'status'], name='tm_board_workspace')]


class BoardAccess(models.Model):
    """People a Team group is shared with by name, and their level."""
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='access')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    level = models.CharField(max_length=10)

    class Meta:
        db_table = 'tm_board_access'
        constraints = [
            models.UniqueConstraint(fields=['board', 'staff'], name='tm_board_access_unique'),
            models.CheckConstraint(condition=Q(level__in=ACCESS_LEVELS), name='tm_board_access_level_valid'),
        ]
        indexes = [models.Index(fields=['staff'], name='tm_board_access_staff')]


class BoardColumn(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='columns')
    name = models.CharField(max_length=200)
    name_key = models.CharField(max_length=200)
    type = models.CharField(max_length=20)
    position = models.IntegerField()
    settings_json = models.TextField(default='{}')
    version = models.IntegerField(default=0)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_columns'
        constraints = [
            models.UniqueConstraint(fields=['board', 'name_key'], name='tm_board_column_name'),
            models.CheckConstraint(condition=Q(type__in=COLUMN_TYPES), name='tm_board_column_type_valid'),
        ]
        indexes = [models.Index(fields=['board', 'position'], name='tm_board_column_order')]


class BoardRow(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='rows')
    position = models.IntegerField()
    values_json = models.TextField(default='{}')
    version = models.IntegerField(default=0)
    created_by = person('created_by', null=False)
    created_at = models.DateTimeField()
    updated_by = person('updated_by')
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_rows'
        indexes = [models.Index(fields=['board', 'position'], name='tm_board_row_order')]


class BoardNote(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='notes')
    row = models.ForeignKey(BoardRow, on_delete=models.CASCADE, related_name='notes')
    author = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    body = models.TextField()
    created_at = models.DateTimeField()
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    deleted_by = person('deleted_by')
    version = models.IntegerField(default=0)

    class Meta:
        db_table = 'tm_board_notes'
        indexes = [models.Index(fields=['row', 'created_at'], name='tm_board_note_row'),
                   models.Index(fields=['board', 'created_at'], name='tm_board_note_board')]


class BoardNoteRevision(models.Model):
    note = models.ForeignKey(BoardNote, on_delete=models.CASCADE, related_name='revisions')
    body = models.TextField()
    action = models.CharField(max_length=10)
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_note_revisions'
        constraints = [models.CheckConstraint(condition=Q(action__in=NOTE_ACTIONS), name='tm_board_note_revision_action_valid')]


class BoardRowAccess(models.Model):
    row = models.ForeignKey(BoardRow, on_delete=models.CASCADE, related_name='access')
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='row_access')
    principal_type = models.CharField(max_length=10)
    principal_id = models.CharField(max_length=60)

    class Meta:
        db_table = 'tm_board_row_access'
        constraints = [
            models.UniqueConstraint(fields=['row', 'principal_type', 'principal_id'], name='tm_board_row_access_unique'),
            models.CheckConstraint(condition=Q(principal_type__in=PRINCIPALS), name='tm_board_row_access_type_valid'),
        ]
        indexes = [models.Index(fields=['board'], name='tm_board_row_access_board')]


class BoardColumnAccess(models.Model):
    column = models.ForeignKey(BoardColumn, on_delete=models.CASCADE, related_name='access')
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='column_access')
    principal_type = models.CharField(max_length=10)
    principal_id = models.CharField(max_length=60)

    class Meta:
        db_table = 'tm_board_column_access'
        constraints = [
            models.UniqueConstraint(fields=['column', 'principal_type', 'principal_id'], name='tm_board_column_access_unique'),
            models.CheckConstraint(condition=Q(principal_type__in=PRINCIPALS), name='tm_board_column_access_type_valid'),
        ]
        indexes = [models.Index(fields=['board'], name='tm_board_column_access_board')]


class BoardView(models.Model):
    """Each person's own layout of a group (column widths and order, columns and rows they hid for themselves)."""
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='views')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    view_json = models.TextField(default='{}')
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_views'
        constraints = [models.UniqueConstraint(fields=['board', 'staff'], name='tm_board_view_unique')]


class BoardImport(models.Model):
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='imports')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    file_name = models.CharField(max_length=400)
    file_size = models.IntegerField()
    sheets_json = models.TextField()
    # db_default: SQL Server keeps a DEFAULT constraint, so code from before this column existed can still insert rows
    # (a code-only rollback stays safe while the migration stays applied).
    source_json = models.TextField(default='{}', db_default='{}')
    status = models.CharField(max_length=10)
    result_json = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField()
    imported_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'tm_board_imports'
        constraints = [models.CheckConstraint(condition=Q(status__in=IMPORT_STATUSES), name='tm_board_import_status_valid')]
        indexes = [models.Index(fields=['board', 'created_at'], name='tm_board_import_board')]


class BoardFile(models.Model):
    """V5.6.9: one file in an Attachment cell (the cell keeps the list of its files' names)."""
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='files')
    row = models.ForeignKey(BoardRow, on_delete=models.CASCADE, related_name='files')
    column = models.ForeignKey(BoardColumn, on_delete=models.CASCADE, related_name='files')
    name = models.CharField(max_length=160)
    mime = models.CharField(max_length=120)
    size = models.IntegerField()
    content = models.BinaryField()
    uploaded_by = person('uploaded_by')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_files'
        indexes = [models.Index(fields=['row', 'column'], name='tm_board_file_cell'),
                   models.Index(fields=['board'], name='tm_board_file_board')]


class BoardCellStyle(models.Model):
    """Presentation only. Values, formulas, filters and sorting remain on BoardRow."""
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='cell_styles')
    row = models.ForeignKey(BoardRow, on_delete=models.CASCADE, related_name='cell_styles')
    column = models.ForeignKey(BoardColumn, on_delete=models.CASCADE, related_name='cell_styles')
    text_color = models.CharField(max_length=7, blank=True, default='')
    background_color = models.CharField(max_length=7, blank=True, default='')
    updated_by = person('updated_by', null=False)
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_cell_styles'
        constraints = [models.UniqueConstraint(fields=['row', 'column'], name='tm_cell_style_unique')]


class BoardDataShare(models.Model):
    """Read/copy grant, never workspace membership or permission to open the source Group."""
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='data_shares')
    recipient = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    column_ids_json = models.TextField(default='[]')
    active = models.BooleanField(default=True)
    version = models.IntegerField(default=0)
    created_by = person('created_by', null=False)
    created_at = models.DateTimeField()
    updated_by = person('updated_by', null=False)
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_data_shares'
        constraints = [models.UniqueConstraint(fields=['board', 'recipient'], name='tm_data_share_recipient')]
        indexes = [models.Index(fields=['recipient', 'active'], name='tm_data_share_active')]


class BoardDelivery(models.Model):
    """Durable self-delivery jobs; originals stay in their attachment tables, prepared PDFs in expiring DeliveryPart rows."""
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='deliveries', null=True, blank=True)
    task = models.ForeignKey('tasks.Task', on_delete=models.PROTECT, related_name='deliveries', null=True, blank=True)
    preview = models.BooleanField(default=False, db_default=False)
    plan_json = models.TextField(default='[]', db_default='[]')
    retry_at = models.DateTimeField(null=True, blank=True)
    worker_token = models.CharField(max_length=40, default='', db_default='')
    staff = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    request_key = models.CharField(max_length=64)
    row_id_snapshot = models.CharField(max_length=60)
    column_id_snapshot = models.CharField(max_length=60)
    file_ids_json = models.TextField()
    mode = models.CharField(max_length=16)
    telegram_user_id = models.BigIntegerField()
    telegram_linked_at = models.DateTimeField()
    status = models.CharField(max_length=16, default='QUEUED')
    # The name the person chose for a combined PDF (empty: the standard name). Originals keep their names.
    file_name = models.CharField(max_length=160, blank=True, default='', db_default='')   # db_default: see BoardImport.source_json
    result_json = models.TextField(default='[]')
    error = models.CharField(max_length=500, blank=True, default='')
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_deliveries'
        constraints = [models.UniqueConstraint(fields=['staff', 'request_key'], name='tm_delivery_request'),
                       models.CheckConstraint(condition=Q(mode__in=['SEPARATE', 'MERGED_PDF']), name='tm_delivery_mode'),
                       models.CheckConstraint(condition=Q(status__in=['QUEUED', 'PREPARING', 'READY', 'APPROVED', 'SENDING', 'SENT', 'PARTIAL', 'FAILED', 'UNKNOWN', 'CANCELLED']), name='tm_delivery_status')]
        indexes = [models.Index(fields=['status', 'created_at'], name='tm_delivery_queue')]


class BoardLiveShare(models.Model):
    """Share Live Data: a recipient reads (and, column by column, edits) the source Group's own cells.

    Unlike BoardDataShare (an independent copy), nothing is copied: a Live Data column in the recipient's Group shows the
    source cells as they are now. It never grants workspace membership or opening the source Group. The grant is checked
    again on every read and write (issuer authority, recipient scope, the columns' own access rules)."""
    id = models.CharField(max_length=60, primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='live_shares')
    recipient = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    active = models.BooleanField(default=True)
    version = models.IntegerField(default=0)
    created_by = person('created_by', null=False)
    created_at = models.DateTimeField()
    updated_by = person('updated_by', null=False)
    updated_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'tm_board_live_shares'
        constraints = [models.UniqueConstraint(fields=['board', 'recipient'], name='tm_live_share_recipient')]
        indexes = [models.Index(fields=['recipient', 'active'], name='tm_live_share_active')]


class BoardLiveColumn(models.Model):
    """One shared source column of a Live Data share, with its permission (VIEW: Viewer, EDIT: Can Edit)."""
    share = models.ForeignKey(BoardLiveShare, on_delete=models.CASCADE, related_name='columns')
    column = models.ForeignKey(BoardColumn, on_delete=models.CASCADE, related_name='live_columns')
    permission = models.CharField(max_length=10)

    class Meta:
        db_table = 'tm_board_live_columns'
        constraints = [models.UniqueConstraint(fields=['share', 'column'], name='tm_live_column_unique'),
                       models.CheckConstraint(condition=Q(permission__in=LIVE_PERMISSIONS), name='tm_live_column_permission')]


class BoardLiveEdit(models.Model):
    """Edit history of live-shared source cells: who, when, which row and column, the value before and after, and how.

    Rows and columns are kept by ID and name (not foreign keys), so the history stays after a row is deleted. Written by
    the application only (never updated); deleting the source Group removes it with the Group, like its notes."""
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name='live_history')
    row_ref = models.CharField(max_length=60)
    column_ref = models.CharField(max_length=60)
    column_name = models.CharField(max_length=200)
    actor = models.ForeignKey(Staff, on_delete=models.PROTECT, related_name='+')
    action = models.CharField(max_length=12)
    before_json = models.TextField(default='null')
    after_json = models.TextField(default='null')
    via = models.CharField(max_length=12)
    share_ref = models.CharField(max_length=60, blank=True, default='')
    created_at = models.DateTimeField()

    class Meta:
        db_table = 'tm_board_live_history'
        constraints = [models.CheckConstraint(condition=Q(action__in=['EDIT', 'ADD_ROW', 'DELETE_ROW', 'IMPORT']), name='tm_live_history_action'),
                       models.CheckConstraint(condition=Q(via__in=['group', 'live', 'import']), name='tm_live_history_via')]
        indexes = [models.Index(fields=['board', 'created_at'], name='tm_live_history_board'),
                   models.Index(fields=['board', 'column_ref', 'created_at'], name='tm_live_history_column')]


class DeliveryPart(models.Model):
    """Short-lived prepared PDF bytes in the existing business database; purged after delivery/expiry."""
    job = models.ForeignKey(BoardDelivery, on_delete=models.CASCADE, related_name='parts')
    position = models.PositiveIntegerField()
    name = models.CharField(max_length=180)
    content = models.BinaryField()

    class Meta:
        db_table = 'tm_delivery_parts'
        constraints = [models.UniqueConstraint(fields=['job', 'position'], name='tm_delivery_part_position')]
