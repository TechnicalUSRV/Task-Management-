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
COLUMN_TYPES = ['TEXT', 'DATE', 'NUMBER', 'STATUS', 'IN_CHARGE', 'SUPPORT', 'FORMULA', 'ATTACHMENT']
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
