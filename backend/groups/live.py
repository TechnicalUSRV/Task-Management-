"""Share Live Data — a live, column-level connection to another Group's own cells (requirement 1).

Architecture (one source of truth):
 - The source Group keeps the only copy of every value. A Live Data share (BoardLiveShare + BoardLiveColumn) lets one
   recipient read chosen columns as Viewer, or change them as Can Edit, column by column.
 - The recipient adds a Live Data column (type LINKED) to their own Group. It stores no values: each time the Group is read,
   the column's cells are looked up in the source rows, matching a key column of the recipient's Group with a key column
   of the shared data (for example Item = Item). Formulas in the recipient's Group can use it, so Profit = Revenue - Cost
   recalculates from the source whenever the source changes.
 - Writing a Live Data cell (Can Edit) writes the source row, in the same command transaction and under the same write lock
   as every other change, with the same "the value you started from" conflict check, and records the edit history.
 - Nothing is copied back and Live Data columns can't be shared onward (neither live nor as an independent copy), so there
   is no synchronization loop. Revoking a share takes effect on the next read: the cells show #N/A and edits are refused.
 - Near real time: every saved change advances the change counter that the web app and the Mini App already watch (every
   4 seconds while visible); a Group being viewed then reloads its rows, which reads the source again.

Every read and write checks the grant again: the person who issued it must still manage and export the source Group (and
edit it, for Can Edit), the recipient must still be active and within the issuer's collaboration scope, and the source
Group's own row and column rules for the recipient still apply. People who can open the source Group themselves read it
with their own rights instead.
"""
import uuid

from accounts.models import User
from core.errors import InputError, fail
from core.rows import update
from core.validation import text

from . import domain as dm, js
from .models import BoardLiveColumn, BoardLiveEdit, BoardLiveShare, BoardRow

LIVE_TYPES = ('TEXT', 'DATE', 'NUMBER', 'STATUS', 'IN_CHARGE', 'SUPPORT', 'FORMULA')   # what can be shared live
EDITABLE = ('TEXT', 'DATE', 'NUMBER', 'STATUS')                                            # what Can Edit may change
KEY_TYPES = ('TEXT', 'NUMBER', 'DATE', 'STATUS')                                           # recipient's match columns
NO_ACCESS = {'error': '#N/A'}
DUPLICATE = {'error': '#DUP!'}
BROKEN = {'error': '#REF!'}
LEVEL = {'VIEW': 1, 'EDIT': 2}


def key_text(col, value, name_of):
    """The text two rows are matched by (numbers by value, other values by their text, ignoring case and spacing)."""
    if dm.empty_value(value) or isinstance(value, dict):
        return None
    col = dm.effective(col)
    if col['type'] in ('NUMBER', 'FORMULA') and js.is_number(value):
        return js.num_str(value)
    k = dm.name_key(dm.cell_text(col, value, name_of))
    return k or None


class LiveData:
    def __init__(self, groups):
        self.g = groups
        self._views = {}

    # ------------------------------------------------------------ the source side (issuer)
    def manager(self, key, actor):
        b, caps = self.g.open_board(key, actor)
        self.g.archived_check(b)
        self.g.need(caps, 'share', 'Managing Live Data requires group-management access.')
        self.g.need(caps, 'export', 'Sharing Live Data requires Groups export permission.')
        return b, caps

    def recipient_allowed(self, b, issuer, recipient, edit=False):
        w = self.g.gov.ws_by_id(b['workspace_id'])
        return (self.g.gov.active(recipient) and self.g.can(recipient, 'view') and (not edit or self.g.can(recipient, 'update'))
                and (recipient == w['owner_id'] or self.g.is_member(w['id'], recipient) or self.g.gov.can_collaborate_outside(issuer, w)))

    def shareable(self, b, actor, caps):
        """The columns this person may share live: visible to them, a value type, and every input of a formula included."""
        visible = self.g.sight(b, actor, caps)['columns']
        return [c for c in visible if c['type'] in LIVE_TYPES]

    def describe(self, key, actor):
        self.g.remember_lookups()
        b, caps = self.manager(key, actor)
        columns = self.shareable(b, actor, caps)
        people = [{'id': s, 'name': self.g.name_of(s)} for s in User.objects.filter(active=True).values_list('staff_id', flat=True)
                  if s != actor and self.recipient_allowed(b, actor, s)]
        shares = []
        for x in BoardLiveShare.objects.filter(board_id=key).order_by('created_at'):
            cols = [{'column_id': c, 'permission': p} for c, p in BoardLiveColumn.objects.filter(share_id=x.id).order_by('id').values_list('column_id', 'permission')]
            shares.append({'id': x.id, 'recipient_id': x.recipient_id, 'name': self.g.name_of(x.recipient_id), 'active': x.active, 'version': x.version,
                           'columns': cols, 'updated_by': self.g.name_of(x.updated_by_id), 'updated_at': x.updated_at.isoformat()})
        return {'people': people, 'shares': shares, 'can_edit': caps['editRows'],
                'columns': [{'id': c['id'], 'name': c['name'], 'type': c['type'], 'editable': c['type'] in EDITABLE and caps['editRows']} for c in columns]}

    def save(self, d, actor):
        b, caps = self.manager(d.get('group_id'), actor)
        recipient = text(d.get('recipient_id'), 'Recipient', 60, True)
        if recipient == actor:
            fail('Choose someone else to share Live Data with.')
        old = BoardLiveShare.objects.filter(board_id=b['id'], recipient_id=recipient).first()
        if old:
            self.g.tasks.check_version({'version': old.version}, d.get('expected_version'))
        active = d.get('active', True)
        if not isinstance(active, bool):
            fail('Choose whether this Live Data share is active.')
        if not old and not active:
            fail('Live Data share not found.', 404)
        wanted = d.get('columns', [])
        if not isinstance(wanted, list) or len(wanted) > dm.GROUP_LIMITS['columns'] or any(
                not isinstance(x, dict) or not isinstance(x.get('column_id'), str) or x.get('permission') not in LEVEL for x in wanted):
            fail('Choose the columns to share and Viewer or Can Edit for each.')
        perms = {}
        for x in wanted:
            perms[x['column_id']] = x['permission']
        if active:
            if not perms:
                fail('Choose at least one column to share live.')
            by_id = {c['id']: c for c in self.shareable(b, actor, caps)}
            if any(k not in by_id for k in perms):
                fail('Choose visible data columns. Attachments and other Live Data columns cannot be shared live.', 409)
            selected = dm.visible_columns(list(by_id.values()), lambda c: c['id'] in perms)
            if {c['id'] for c in selected} != set(perms):
                fail('Include every column a shared formula uses.', 422)
            for k, p in perms.items():
                if p == 'EDIT' and (by_id[k]['type'] not in EDITABLE or not caps['editRows']):
                    fail(f"“{by_id[k]['name']}” can be shared as Viewer only: {'formulas and people are calculated or chosen in the source group' if by_id[k]['type'] not in EDITABLE else 'you cannot edit this group'}.", 422)
            if not self.recipient_allowed(b, actor, recipient, edit='EDIT' in perms.values()):
                fail('This recipient is outside your permitted collaboration scope, or their role cannot use (or edit) Groups.', 403)
        at = self.g.now()
        share = old or BoardLiveShare(id=uuid.uuid4().hex, board_id=b['id'], recipient_id=recipient, created_by_id=actor, created_at=at)
        share.active, share.updated_by_id, share.updated_at = active, actor, at
        share.version = old.version + 1 if old else 0
        share.revoked_at = None if active else at
        share.save()
        if active:
            BoardLiveColumn.objects.filter(share_id=share.id).delete()
            BoardLiveColumn.objects.bulk_create(BoardLiveColumn(share_id=share.id, column_id=k, permission=p) for k, p in perms.items())
        edit = sum(1 for p in perms.values() if p == 'EDIT')
        self.g.record(actor, b, 'Live Data share updated' if active else 'Live Data share revoked',
                      f"{self.g.name_of(recipient)} · {len(perms)} {'column' if len(perms) == 1 else 'columns'}{f' · {edit} can edit' if edit else ''}" if active
                      else self.g.name_of(recipient))
        self._views = {}
        return {'id': share.id, 'type': 'tm_group_live_share', 'message': 'Live Data share saved.' if active else 'Live Data share revoked.'}

    # ------------------------------------------------------------ what one person may reach in a source Group
    def view(self, board_id, staff):
        """{board, perms: {column: VIEW|EDIT}, rowOk, columns, shares: {column: share}} or None (memoized per request)."""
        key = (board_id, staff)
        if key in self._views:
            return self._views[key]
        # Two groups showing Live Data from each other: while one is being resolved, the other's Live Data columns are
        # unavailable inside it (Live Data columns are never shared onward, so nothing else depends on them).
        self._views[key] = None
        b = self.g.board_row(board_id)
        out = None
        if b and self.g.gov.active(staff) and self.g.can(staff, 'view') and self.g.ws_active(b):
            perms, shares, row_ok = {}, {}, None
            caps = self.g.caps_for(b, staff)
            if caps['view']:   # someone who can open the source Group reads it with their own rights
                s = self.g.sight(b, staff, caps)
                for c in s['columns']:
                    if c['type'] in LIVE_TYPES:
                        perms[c['id']] = 'EDIT' if caps['editRows'] and c['type'] in EDITABLE else 'VIEW'
                row_ok, columns = s['rowOk'], s['all']
            share = BoardLiveShare.objects.filter(board_id=board_id, recipient_id=staff, active=True).first()
            if share and self.valid(b, share):
                s = self.g.sight(b, staff, {'seeAll': False})   # a share never inherits the issuer's wider rights
                visible = {c['id']: c for c in s['columns']}
                issuer_edit = self.g.caps_for(b, share.updated_by_id)['editRows'] and self.g.can(staff, 'update')
                for c, p in BoardLiveColumn.objects.filter(share_id=share.id).values_list('column_id', 'permission'):
                    if c not in visible or visible[c]['type'] not in LIVE_TYPES:
                        continue
                    p = 'EDIT' if p == 'EDIT' and issuer_edit and visible[c]['type'] in EDITABLE else 'VIEW'
                    if LEVEL[p] > LEVEL.get(perms.get(c), 0):
                        perms[c], shares[c] = p, share.id
                if row_ok is None:
                    row_ok = s['rowOk']
                columns = s['all']
            if perms:
                out = {'board': b, 'perms': perms, 'rowOk': row_ok, 'columns': columns, 'shares': shares, 'rows': None}
        self._views[key] = out
        return out

    def valid(self, b, share):
        try:
            self.manager(b['id'], share.updated_by_id)
        except InputError:
            return False
        return self.recipient_allowed(b, share.updated_by_id, share.recipient_id)

    def source_rows(self, v, name_of):
        """The source rows this person may see, with formula results (computed once per request)."""
        if v['rows'] is None:
            prepared = dm.prepare_formulas(v['columns'])
            v['rows'] = [{**r, 'computed': dm.compute_row(r['values'], v['columns'], prepared)}
                         for r in self.g.rows_of(v['board']['id']) if v['rowOk'](r['id'])]
        return v['rows']

    @staticmethod
    def cell(col, r):
        return r['computed'].get(col['id']) if col['type'] == 'FORMULA' else r['values'].get(col['id'])

    # ------------------------------------------------------------ Live Data columns in the recipient's Group
    def access_map(self, staff, linked):
        """{column id: VIEW|EDIT|None}: whether this reader may see each Live Data column (source and key reachable)."""
        out = {}
        for c in linked:
            st = c.get('settings') or {}
            v = self.view(st.get('source_group_id'), staff) if st.get('source_group_id') else None
            perm = v['perms'].get(st.get('source_column_id')) if v else None
            out[c['id']] = perm if perm and v['perms'].get(st.get('source_key_id')) else None
        return out

    def meta(self, staff, col, perm):
        """What the screen needs to show and edit a Live Data column. Nothing about the source unless it is reachable."""
        st = col.get('settings') or {}
        source = st.get('source') or {}
        if not perm:
            return {'state': 'no_access', 'permission': None, 'source_type': dm.effective(col)['type'], 'source_settings': {}, 'key_column_id': st.get('key_column_id')}
        v = self.view(st['source_group_id'], staff)
        current = next((c for c in v['columns'] if c['id'] == st['source_column_id']), None)
        key = next((c for c in v['columns'] if c['id'] == st.get('source_key_id')), None)
        if not current or not key:
            return {'state': 'broken', 'permission': None, 'source_type': source.get('type') or 'TEXT', 'source_settings': {}, 'key_column_id': st.get('key_column_id')}
        return {'state': 'ok', 'permission': perm, 'source_type': current['type'], 'source_settings': current.get('settings') or {},
                'source_name': current['name'], 'source_key_name': key['name'], 'source_group_id': v['board']['id'], 'source_group_name': v['board']['name'],
                'source_column_id': current['id'], 'key_column_id': st.get('key_column_id'), 'can_history': perm == 'EDIT' or self.manages(v['board'], staff)}

    def manages(self, b, staff):
        caps = self.g.caps_for(b, staff)
        return caps['share'] and caps['export']

    def refresh(self, staff, columns, access):
        """Live Data columns described with their source's current type and settings (labels, decimals) for this reader."""
        out = []
        for c in columns:
            if c['type'] == 'LINKED' and access.get(c['id']):
                m = self.meta(staff, c, access[c['id']])
                if m['state'] == 'ok':
                    c = {**c, 'settings': {**c['settings'], 'source': {'type': m['source_type'], 'settings': m['source_settings'], 'name': m['source_name']}}}
            out.append(c)
        return out

    def values(self, b, staff, columns, rows, access):
        """{row id: {Live Data column id: value}} for these local rows: the matching source cell, empty when nothing
        matches, #DUP! when several source records match, #N/A when this reader may not see the source."""
        out = {r['id']: {} for r in rows}
        for c in columns:
            if c['type'] != 'LINKED':
                continue
            st = c.get('settings') or {}
            perm = access.get(c['id'])
            v = self.view(st.get('source_group_id'), staff) if perm else None
            source = next((x for x in (v or {}).get('columns', []) if x['id'] == st.get('source_column_id')), None)
            key = next((x for x in (v or {}).get('columns', []) if x['id'] == st.get('source_key_id')), None)
            local_key = next((x for x in columns if x['id'] == st.get('key_column_id')), None)
            if not perm:
                for r in rows:
                    out[r['id']][c['id']] = NO_ACCESS
                continue
            if not source or not key or not local_key:
                for r in rows:
                    out[r['id']][c['id']] = BROKEN
                continue
            index = {}
            for sr in self.source_rows(v, self.g.name_of):
                k = key_text(key, self.cell(key, sr), self.g.name_of)
                if k is not None:
                    index.setdefault(k, []).append(sr)
            for r in rows:
                k = key_text(local_key, r['values'].get(local_key['id']), self.g.name_of)
                found = index.get(k) if k is not None else None
                if not found:
                    continue
                out[r['id']][c['id']] = DUPLICATE if len(found) > 1 else self.cell(source, found[0])
        return out

    def match(self, col, local_row, staff):
        """The one source row a local row's Live Data cell belongs to (for writing)."""
        st = col.get('settings') or {}
        v = self.view(st.get('source_group_id'), staff)
        if not v:
            fail('This Live Data is no longer shared with you.', 403)
        key = next((x for x in v['columns'] if x['id'] == st.get('source_key_id')), None)
        local_key = next((x for x in self.g.columns_of(local_row['board_id']) if x['id'] == st.get('key_column_id')), None)
        if not key or not local_key or not v['perms'].get(key['id']):
            fail('This Live Data column lost its connection. Ask the source group’s owner to share it again.', 409)
        k = key_text(local_key, local_row['values'].get(local_key['id']), self.g.name_of)
        found = [sr for sr in self.source_rows(v, self.g.name_of) if k is not None and key_text(key, self.cell(key, sr), self.g.name_of) == k]
        if not found:
            fail(f"No shared record matches this row’s “{local_key['name']}”. Fill it in first, or add the source records.", 409)
        if len(found) > 1:
            fail(f"Several shared records match this row’s “{local_key['name']}”, so the change can’t be placed. Ask the source group’s owner to make the key unique.", 409)
        return v, found[0]

    # ------------------------------------------------------------ writing a shared cell
    def write(self, actor, board_id, row_id, col_id, value, expected, via='live'):
        v = self.view(board_id, actor)
        if not v or col_id not in v['perms']:
            fail('Live Data not found.', 404)
        if v['perms'][col_id] != 'EDIT':
            fail('You can view this Live Data but not change it (Viewer).', 403)
        b = v['board']
        self.g.archived_check(b)
        found = BoardRow.objects.filter(id=row_id, board_id=b['id']).first()
        if not found or not v['rowOk'](found.id):
            fail('This shared record was deleted or is no longer shared with you. Reload.', 404)
        col = next(c for c in v['columns'] if c['id'] == col_id)
        values = js.loads(found.values_json, {})
        current = values.get(col_id)
        was = None if expected == '' else expected
        if not js.same(current, was):
            shown = dm.cell_text(col, current, self.g.name_of) or 'empty'
            fail(f"Someone changed “{col['name']}” in the source to “{shown}” while you were editing. Your change was not saved: check the new value and try again.",
                 409, {'code': 'cell_conflict', 'column': col_id, 'current': current})
        r = dm.clean_cell(col, value, current=current)
        if not r['ok']:
            fail(f"{col['name']}: {r['error']}", 422, {'code': 'value', 'column': col_id, 'error': r['error']})
        nxt = dict(values)
        if dm.empty_value(r['value']):
            nxt.pop(col_id, None)
        else:
            nxt[col_id] = r['value']
        if js.same(nxt, values):
            return False
        data = js.dumps(nxt)
        if js.length(data) > js.length(found.values_json):
            self.g.size_check(b, data, js.length(found.values_json))
        at = self.g.now()
        update(BoardRow, found.id, {'values_json': data, 'version': found.version + 1, 'updated_by': actor, 'updated_at': at})
        self.g.touch(b)
        self.g.record(actor, b, 'Live Data edited', f"{found.id} · {col['name']}")
        self.history(b['id'], found.id, [col], {col_id: current}, {col_id: nxt.get(col_id)}, actor, 'EDIT', via, v['shares'].get(col_id, ''))
        self._views = {}
        return True

    def update_cell(self, d, actor):
        """tm.group.live.update: change one shared cell from the Live Data panel (no local Group needed)."""
        share = BoardLiveShare.objects.filter(id=text(d.get('share_id'), 'Live Data share', 60, True), recipient_id=actor, active=True).first()
        if not share:
            fail('Live Data not found.', 404)
        if 'expected' not in d:
            fail('Send the value you started from, so changes by others are not overwritten.', 400)
        changed = self.write(actor, share.board_id, text(d.get('row_id'), 'Row', 60, True), text(d.get('column_id'), 'Column', 60, True),
                             d.get('value'), d.get('expected'))
        return {'id': d['row_id'], 'type': 'tm_group_live', 'message': 'Saved to the source group.' if changed else 'No change.', 'unchanged': not changed}

    # ------------------------------------------------------------ edit history
    def shared_columns(self, board_id):
        key = ('shared', board_id)
        if key not in self._views:
            self._views[key] = set(BoardLiveColumn.objects.filter(share__board_id=board_id, share__active=True).values_list('column_id', flat=True))
        return self._views[key]

    def history(self, board_id, row_id, columns, before, after, actor, action, via, share=''):
        at = self.g.now()
        BoardLiveEdit.objects.bulk_create(
            BoardLiveEdit(board_id=board_id, row_ref=row_id, column_ref=c['id'], column_name=c['name'][:200], actor_id=actor, action=action,
                          before_json=js.dumps(before.get(c['id'])), after_json=js.dumps(after.get(c['id'])), via=via, share_ref=share or '', created_at=at)
            for c in columns if not js.same(before.get(c['id']), after.get(c['id'])))

    def record_change(self, b, row_id, columns, before, after, actor, action='EDIT', via='group'):
        """Called by every write to a Group's rows: the shared columns that changed go into the Live Data history."""
        shared = self.shared_columns(b['id'])
        if shared:
            self.history(b['id'], row_id, [c for c in columns if c['id'] in shared], before or {}, after or {}, actor, action, via)

    def history_read(self, key, staff, p):
        """GET /api/tasks/group/live-history: the source Group's managers see every shared column's history; recipients
        with Can Edit see their columns' history (for rows they may see). Filter by days, person and column."""
        b = self.g.board_row(str(key or '')[:60])
        if not b:
            fail('Group not found.', 404)
        caps = self.g.caps_for(b, staff)
        if caps['view'] and caps['share'] and caps['export']:
            columns, row_ok = None, (lambda _row: True)
            readable = self.g.sight(b, staff, caps)['columns']
        else:
            v = self.view(b['id'], staff)
            columns = {c for c, perm in (v or {}).get('perms', {}).items() if perm == 'EDIT'} if v else set()
            if not columns:
                fail('Only people who can edit this Live Data (or manage its group) can see its history.', 403)
            row_ok = v['rowOk']
            readable = [c for c in v['columns'] if c['id'] in v['perms']]
        # Records are named by the first column this reader may see (for example the item), never by a hidden one.
        label_col = next((c for c in readable if c['type'] in ('TEXT', 'NUMBER', 'DATE', 'STATUS')), None)
        q = BoardLiveEdit.objects.filter(board_id=b['id'])
        if columns is not None:
            q = q.filter(column_ref__in=list(columns))
        if p.get('column'):
            q = q.filter(column_ref=str(p['column'])[:60])
        if p.get('actor'):
            q = q.filter(actor_id=str(p['actor'])[:60])
        zone = self.g.tasks.zone_of(staff)
        from .service import _next_day, _start_of_day
        try:
            if p.get('from'):
                q = q.filter(created_at__gte=_start_of_day(str(p['from'])[:10], zone))
            if p.get('to'):
                q = q.filter(created_at__lt=_start_of_day(_next_day(str(p['to'])[:10]), zone))
        except ValueError:
            fail('Enter valid dates (YYYY-MM-DD).', 400)
        by_id = {c['id']: c for c in self.g.columns_of(b['id'])}
        items = [x for x in q.order_by('-created_at', '-id') if row_ok(x.row_ref)]
        offset = max(0, js.parse_int(p.get('offset')) or 0)
        limit = max(1, min(200, js.parse_int(p.get('limit')) or 50))

        def shown(x, raw):
            value = js.loads(raw, None)
            col = by_id.get(x.column_ref)
            return dm.cell_text(col, value, self.g.name_of) if col else js.to_js_string(value if value is not None else '')
        people = sorted({x.actor_id for x in items})
        page = items[offset:offset + limit]
        labels = {}
        if label_col:
            for rid, raw in BoardRow.objects.filter(board_id=b['id'], id__in=list({x.row_ref for x in page})).values_list('id', 'values_json'):
                labels[rid] = dm.cell_text(label_col, js.loads(raw, {}).get(label_col['id']), self.g.name_of)[:80]
        return {'group': {'id': b['id'], 'name': b['name']}, 'zone': zone, 'total': len(items), 'offset': offset, 'limit': limit,
                'people': [{'id': s, 'name': self.g.name_of(s)} for s in people],
                'columns': [{'id': c, 'name': (by_id.get(c) or {}).get('name') or next((x.column_name for x in items if x.column_ref == c), c)}
                            for c in sorted({x.column_ref for x in items})],
                'items': [{'id': x.id, 'at': x.created_at.isoformat(), 'actor_id': x.actor_id, 'actor': self.g.name_of(x.actor_id),
                           'row_id': x.row_ref, 'row': labels.get(x.row_ref) or '', 'column_id': x.column_ref, 'column': (by_id.get(x.column_ref) or {}).get('name') or x.column_name,
                           'action': x.action, 'via': x.via, 'before': shown(x, x.before_json), 'after': shown(x, x.after_json)}
                          for x in page]}

    # ------------------------------------------------------------ the recipient's side
    def sources(self, destination, actor):
        """Live Data shared with this person, for adding a Live Data column to the Group `destination`."""
        self.g.remember_lookups()
        _, caps = self.g.open_board(destination, actor)
        self.g.need(caps, 'structure', 'Adding a Live Data column needs “Can manage” access to this group.')
        found = []
        for share in BoardLiveShare.objects.filter(recipient_id=actor, active=True).exclude(board_id=destination).order_by('created_at'):
            v = self.view(share.board_id, actor)
            if not v or not v['shares']:
                continue
            cols = [{'id': c['id'], 'name': c['name'], 'type': c['type'], 'permission': v['perms'][c['id']]}
                    for c in v['columns'] if v['shares'].get(c['id']) == share.id]
            if cols:
                found.append({'share_id': share.id, 'group_id': share.board_id, 'group_name': v['board']['name'],
                              'owner': self.g.name_of(v['board']['owner_id']), 'shared_by': self.g.name_of(share.updated_by_id), 'columns': cols})
        return {'sources': found}

    def browse(self, share_id, actor, p=None):
        """GET /api/tasks/group/live: the shared columns and records of one Live Data share, as they are now."""
        p = p or {}
        share = BoardLiveShare.objects.filter(id=str(share_id or '')[:60], recipient_id=actor, active=True).first()
        v = self.view(share.board_id, actor) if share else None
        if not v or share.id not in v['shares'].values():
            fail('Live Data not found.', 404)
        cols = [c for c in v['columns'] if v['shares'].get(c['id']) == share.id]
        rows = self.source_rows(v, self.g.name_of)
        offset = max(0, js.parse_int(p.get('offset')) or 0)
        limit = max(1, min(200, js.parse_int(p.get('limit')) or 50))
        return {'share_id': share.id, 'group': {'id': v['board']['id'], 'name': v['board']['name']}, 'total': len(rows), 'offset': offset, 'limit': limit,
                'columns': [{'id': c['id'], 'name': c['name'], 'type': c['type'], 'settings': c.get('settings') or {}, 'permission': v['perms'][c['id']]} for c in cols],
                'rows': [{'id': r['id'], 'version': r['version'], 'values': {c['id']: self.cell(c, r) for c in cols if not dm.empty_value(self.cell(c, r))}}
                         for r in rows[offset:offset + limit]]}

    def linked_settings(self, b, actor, s, given, old=None):
        """Checks a Live Data column's connection when it is created (column_save, type LINKED)."""
        if old:
            return old['settings']
        share = BoardLiveShare.objects.filter(id=str(given.get('share_id') or '')[:60], recipient_id=actor, active=True).first()
        v = self.view(share.board_id, actor) if share else None
        if not v:
            fail('Choose Live Data that is shared with you.', 404)
        if v['board']['id'] == b['id']:
            fail('A group cannot show Live Data from itself.', 422)
        source = next((c for c in v['columns'] if c['id'] == given.get('source_column_id') and c['id'] in v['perms']), None)
        key = next((c for c in v['columns'] if c['id'] == given.get('source_key_id') and c['id'] in v['perms']), None)
        local_key = next((c for c in s['columns'] if c['id'] == given.get('key_column_id')), None)
        if not source or not key:
            fail('Choose a shared column and a shared column to match records by.', 422)
        if not local_key or local_key['type'] not in KEY_TYPES:
            fail('Choose one of this group’s Text, Number, Date or Status columns to match records by.', 422)
        return {'share_id': share.id, 'source_group_id': v['board']['id'], 'source_column_id': source['id'], 'source_key_id': key['id'],
                'key_column_id': local_key['id'], 'source': {'type': source['type'], 'settings': source.get('settings') or {}, 'name': source['name']}}

    def add_rows(self, d, actor):
        """tm.group.live.rows: add a row (with its match key) for every shared record that no row of this group matches."""
        b, caps = self.g.open_board(d.get('group_id'), actor)
        self.g.archived_check(b)
        self.g.need(caps, 'addRows', 'You can’t add records to this group.')
        all_ = self.g.columns_of(b['id'])
        s = self.g.sight(b, actor, caps, all_)
        col = next((c for c in s['columns'] if c['id'] == d.get('column_id') and c['type'] == 'LINKED'), None)
        if not col or not s['link_access'].get(col['id']):
            fail('Live Data column not found.', 404)
        st = col['settings']
        v = self.view(st['source_group_id'], actor)
        key = next((x for x in v['columns'] if x['id'] == st['source_key_id']), None)
        local_key = next((x for x in all_ if x['id'] == st['key_column_id']), None)
        if not key or not local_key:
            fail('This Live Data column lost its connection.', 409)
        have = {key_text(local_key, r['values'].get(local_key['id']), self.g.name_of) for r in self.g.rows_of(b['id'])}
        labels = dm.status_labels(local_key) if local_key['type'] == 'STATUS' else []
        added, seen = 0, set()
        for sr in self.source_rows(v, self.g.name_of):
            raw = self.cell(key, sr)
            k = key_text(key, raw, self.g.name_of)
            if k is None or k in have or k in seen:
                continue
            seen.add(k)
            value = dm.convert_value(dm.effective(key), local_key, raw, labels, self.g.name_of)
            value = value.get('value') if isinstance(value, dict) else value
            if dm.empty_value(value):
                continue
            self.g.row_add({'group_id': b['id'], 'values': {local_key['id']: value}}, actor)
            added += 1
        return {'id': b['id'], 'type': 'tm_group', 'added': added,
                'message': f"{added} {'record' if added == 1 else 'records'} added." if added else 'Every shared record already has a row.'}

    # ------------------------------------------------------------ protecting the connections
    def column_in_use(self, b, col):
        """Why a column can't change type or be deleted now (a live-shared source column, or a Live Data match key)."""
        n = BoardLiveColumn.objects.filter(column_id=col['id'], share__active=True).values('share__recipient_id').distinct().count()
        if n:
            return f"“{col['name']}” is shared as Live Data with {n} {'person' if n == 1 else 'people'}. Change or revoke that Live Data share first."
        keyed = [c['name'] for c in self.g.columns_of(b['id']) if c['type'] == 'LINKED' and (c.get('settings') or {}).get('key_column_id') == col['id']]
        if keyed:
            return f"“{col['name']}” matches the records of the Live Data column {', '.join('“' + x + '”' for x in keyed)}. Delete or change that column first."
        return None
