"""Explicit, revocable read/copy grants. Never grant workspace membership or source edits."""
from core.i18n import msg as _message
import hashlib
import uuid

from accounts.models import User
from core.errors import InputError, fail
from core.rows import row
from . import domain as dm, js
from .models import Board, BoardDataShare, BoardImport


class DataSharing:
    def __init__(self, groups):
        self.g = groups

    def manager(self, key, actor):
        b, caps = self.g.open_board(key, actor)
        self.g.archived_check(b)
        self.g.need(caps, 'share', _message('Managing data shares requires group-management access.'))
        self.g.need(caps, 'export', _message('Sharing data requires Groups export permission.'))
        return b, caps

    def recipient_allowed(self, b, actor, recipient):
        w = self.g.gov.ws_by_id(b['workspace_id'])
        return (self.g.gov.active(recipient) and self.g.can(recipient, 'view') and
                (recipient == w['owner_id'] or self.g.is_member(w['id'], recipient) or self.g.gov.can_collaborate_outside(actor, w)))

    def describe(self, key, actor):
        self.g.remember_lookups()  # read-only: one permission/membership lookup per person, not per check
        b, _ = self.manager(key, actor)
        people = [{'id': s, 'name': self.g.name_of(s)} for s in User.objects.filter(active=True).values_list('staff_id', flat=True)
                  if s != actor and self.recipient_allowed(b, actor, s)]
        grants = [{'id': x.id, 'recipient_id': x.recipient_id, 'name': self.g.name_of(x.recipient_id),
                   'column_ids': js.loads(x.column_ids_json, []), 'active': x.active, 'version': x.version}
                  for x in BoardDataShare.objects.filter(board_id=key).order_by('created_at')]
        return {'people': people, 'shares': grants}

    def save(self, d, actor):
        b, caps = self.manager(d.get('group_id'), actor)
        recipient = d.get('recipient_id')
        old = BoardDataShare.objects.filter(board_id=b['id'], recipient_id=recipient).first()
        if old:
            self.g.tasks.check_version({'version': old.version}, d.get('expected_version'))
        active = d.get('active', True)
        if not isinstance(active, bool):
            fail(_message('Choose whether this share is active.'))
        # Revocation remains possible after the recipient is disabled or moves outside scope.
        if active and not self.recipient_allowed(b, actor, recipient):
            fail(_message('This recipient is outside your permitted collaboration scope.'), 403)
        ids = d.get('column_ids', [])
        if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids) or len(ids) > 200:
            fail(_message('Choose columns to share.'))
        ids = list(dict.fromkeys(ids))
        visible = self.g.sight(b, actor, caps)['columns']
        selectable = dm.visible_columns(visible, lambda c: c['id'] in ids and c['type'] not in ('ATTACHMENT', 'LINKED'))
        if active and (not ids or set(ids) != {c['id'] for c in selectable}):
            fail('Select visible data columns. Include a formula’s input columns. Attachments and Live Data columns cannot be copied by this import.')
        if not old and not active:
            fail(_message('Share not found.'), 404)
        now = self.g.now()
        grant = old or BoardDataShare(id=uuid.uuid4().hex, board_id=b['id'], recipient_id=recipient,
                                     created_by_id=actor, created_at=now)
        grant.column_ids_json, grant.active = js.dumps(ids), active
        grant.updated_by_id, grant.updated_at = actor, now
        grant.version = old.version + 1 if old else 0
        grant.save()
        self.g.record(actor, b, _message('Data share updated') if active else _message('Data share revoked'), f'{recipient} · {len(ids)} columns')
        return {'id': grant.id, 'message': _message('Data share saved.') if active else _message('Data share revoked.')}

    def source(self, key, actor):
        b = self.g.board_row(key)
        if not b or not self.g.gov.active(actor) or not self.g.can(actor, 'view'):
            fail(_message('Source not found.'), 404)
        caps = self.g.caps_for(b, actor)
        grant = None
        if caps['view'] and caps['export']:
            sight = self.g.sight(b, actor, caps)
        else:
            grant = BoardDataShare.objects.filter(board_id=key, recipient_id=actor, active=True).first()
            if not grant:
                fail(_message('Source not found.'), 404)
            try:
                self.manager(key, grant.updated_by_id)
            except InputError:
                fail(_message('The source share is no longer authorized.'), 403)
            if not self.recipient_allowed(b, grant.updated_by_id, actor):
                fail(_message('The source share is no longer authorized.'), 403)
            # A copy grant never inherits its issuer's seeAll or editing rights.
            sight = self.g.sight(b, actor, {'seeAll': False})
            allowed = set(js.loads(grant.column_ids_json, []))
            sight['columns'] = dm.visible_columns(sight['columns'], lambda c: c['id'] in allowed)
            sight['colIds'] = {c['id'] for c in sight['columns']}
        self.g.archived_check(b)
        # Live Data columns belong to another group: they are never copied onward (nor formulas using them).
        columns = dm.visible_columns([c for c in sight['columns'] if c['type'] != 'ATTACHMENT'], lambda c: c['type'] != 'LINKED')
        return b, sight, columns, grant

    def sources(self, destination, actor):
        self.g.remember_lookups()  # read-only pass over every active Group
        _, caps = self.g.open_board(destination, actor)
        self.g.need(caps, 'import', _message('You cannot import into this group.'))
        found = []
        for key in Board.objects.filter(status='ACTIVE').exclude(id=destination).values_list('id', flat=True):
            try:
                b, _, cols, grant = self.source(key, actor)
            except InputError:
                continue
            if cols:
                found.append({'id': key, 'name': b['name'], 'shared': bool(grant)})
        return {'sources': found}

    def snapshot(self, source_id, actor, column_ids=None, row_ids=None):
        b, sight, cols, grant = self.source(source_id, actor)
        if column_ids is not None:
            if not isinstance(column_ids, list) or not column_ids or len(column_ids) > 200 or not all(isinstance(x, str) for x in column_ids):
                fail(_message('Choose source columns.'))
            by_id = {c['id']: c for c in cols}
            if any(x not in by_id for x in column_ids) or len(column_ids) != len(set(column_ids)):
                fail(_message('Source columns changed or are no longer shared.'), 409)
            cols = [by_id[x] for x in column_ids]
        if row_ids is not None and (not isinstance(row_ids, list) or not row_ids or len(row_ids) > 20000 or not all(isinstance(x, str) for x in row_ids)):
            fail(_message('Choose source rows.'))
        prepared = dm.prepare_formulas(sight['all'])
        wanted = set(row_ids) if row_ids is not None else None  # up to 20,000 IDs: a set, not a list scan per row
        rows = []
        for r in self.g.rows_of(b['id']):
            if not sight['rowOk'](r['id']) or wanted is not None and r['id'] not in wanted:
                continue
            out = {'values': r['values'], 'computed': dm.compute_row(r['values'], sight['all'], prepared)}
            cells = []
            for c in cols:
                v = out.get('computed', {}).get(c['id']) if c['type'] == 'FORMULA' else out['values'].get(c['id'])
                if c['type'] == 'STATUS':
                    v = next((x['name'] for x in dm.status_labels(c) if x['id'] == v), '')
                if c['type'] == 'SUPPORT':
                    v = ', '.join(v or [])
                cells.append({'v': v})
            rows.append({'id': r['id'], 'cells': cells})
        if wanted is not None and wanted != {r['id'] for r in rows}:
            fail(_message('Source rows changed or are no longer shared.'), 409)
        # No expressions, unrelated columns, workspace membership, or hidden-row metadata leave this service.
        return {'name': b['name'], 'columns': [{'id': c['id'], 'name': c['name'], 'type': 'NUMBER' if c['type'] == 'FORMULA' else c['type']} for c in cols],
                'rows': rows, 'grant': [grant.id, grant.version] if grant else None}

    @staticmethod
    def fingerprint(snapshot):
        return hashlib.sha256(js.dumps(snapshot).encode()).hexdigest()

    def browse(self, destination, source_id, actor):
        _, caps = self.g.open_board(destination, actor)
        self.g.need(caps, 'import', _message('You cannot import into this group.'))
        return self.snapshot(source_id, actor)

    def stage(self, d, actor):
        b, caps = self.g.open_board(d.get('group_id'), actor)
        self.g.archived_check(b)
        self.g.need(caps, 'import', _message('You cannot import into this group.'))
        if b['id'] == d.get('source_id'):
            fail(_message('Choose a different source group.'))
        snap = self.snapshot(d.get('source_id'), actor, d.get('column_ids', []), d.get('row_ids', []))
        source = {'id': d['source_id'], 'columns': d['column_ids'], 'rows': d['row_ids'], 'fingerprint': self.fingerprint(snap)}
        sheet = {'name': snap['name'], 'hidden': False, 'truncated': False, 'formulas_without_results': 0,
                 'columns': len(snap['columns']), 'rows': [[{'v': c['name']} for c in snap['columns']]] + [r['cells'] for r in snap['rows']]}
        data = js.dumps([sheet])
        if len(data) > dm.GROUP_LIMITS['groupChars']:
            fail('Select fewer source rows.', 413)
        imp = BoardImport.objects.create(id=uuid.uuid4().hex, board_id=b['id'], staff_id=actor, file_name=snap['name'], file_size=len(data),
                                        source_json=js.dumps(source), sheets_json=data, status='UPLOADED', created_at=self.g.now())
        self.g.record(actor, b, _message('Internal import prepared'), f'{snap["name"]} · {len(snap["rows"])} rows')
        return {'id': imp.id, 'message': _message('Source data ready for mapping.'), 'import': {**self.g.imports.summary(row(imp), [sheet]), 'internal': True,
                                                                                'source_columns': snap['columns']}}

    def validate(self, imp, actor):
        source = js.loads(imp['source_json'], {})
        if not source or imp['status'] == 'IMPORTED':
            return
        current = self.snapshot(source['id'], actor, source['columns'], source['rows'])
        if self.fingerprint(current) != source['fingerprint']:
            fail(_message('Source data or sharing changed. Select the source again and review a new import preview.'), 409)
