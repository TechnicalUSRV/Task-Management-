import { uiText, useLanguage } from "./i18n";
import type { LucideIcon } from 'lucide-react';
import { BadgeCheck, ChevronRight, FileCheck2, Megaphone, Plus, Target, UserRoundCheck, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type Row } from './components';
import { TABLES } from './crm-config';
import type { Workspace } from './ui';
import { CrmTabs } from './crm-ui';
import { formatMoney, localDate } from './format';
import { Alert, Card, DataTable, DateText, EmptyState, Money, PageHeader, StatusBadge } from './ui-kit';

type Stage = { type: string; slug: string; title: string; text: string; icon: LucideIcon; stat: string };

/** CRM overview: the sales lifecycle as a flow, plus the queues that need action. */
export function CRMWorkflow(w: Workspace) {
  useLanguage();
  const d = w.data, c = w.currency;
  const customer = (id: string) => d.contacts.find((x: Row) => x.id === id)?.customer_name;
  const open = d.opportunities.filter((o: Row) => o.status === 'OPEN');
  const won = d.opportunities.filter((o: Row) => o.status === 'WON');
  const ready = won.filter((o: Row) => !d.quotations.some((q: Row) => q.opportunity_id === o.id));
  const pending = d.quotations.filter((q: Row) => q.status === 'SUBMITTED');
  const qualified = d.leads.filter((l: Row) => l.status === 'QUALIFIED');
  const horizon = new Date(Date.parse(`${localDate()}T12:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
  const closingSoon = open.filter((o: Row) => o.estimation <= horizon).sort((a: Row, b: Row) => a.estimation.localeCompare(b.estimation));
  const stages: Stage[] = [
    { type: 'campaign', slug: 'campaigns', title: uiText("Campaigns"), text: uiText("Capture inquiries and generate leads"), icon: Megaphone, stat: `${d.campaigns.filter((x: Row) => x.status === 'ACTIVE').length} active` },
    { type: 'contact', slug: 'contacts', title: uiText("Contacts"), text: uiText("Register customers and owners"), icon: UsersRound, stat: `${d.contacts.filter((x: Row) => x.active !== 0).length} active` },
    { type: 'lead', slug: 'leads', title: uiText("Leads"), text: uiText("Qualify and convert prospects"), icon: UserRoundCheck, stat: `${qualified.length} qualified` },
    { type: 'opportunity', slug: 'opportunities', title: uiText("Opportunities"), text: uiText("Price deals and close them"), icon: Target, stat: `${formatMoney(open.reduce((n: number, o: Row) => n + o.total_cents, 0), c)} open` },
    { type: 'quotation', slug: 'quotations', title: uiText("Sales quotations"), text: uiText("Revise, approve, get acceptance"), icon: FileCheck2, stat: `${pending.length} awaiting approval` },
    { type: 'account', slug: 'accounts', title: uiText("Business Accounts"), text: uiText("Created when a sale is won"), icon: BadgeCheck, stat: `${d.accounts.filter((x: Row) => x.status === 'ACTIVE').length} active` },
  ].filter(s => w.can('crm.' + TABLES[s.type]));
  return (
    <>
      <PageHeader crumbs={[{ label: 'CRM' }]} title="CRM" description={uiText("Follow every customer from the first inquiry to a confirmed relationship. A won sale creates the Business Account and enables formal quotations.")}
        actions={<>
          {w.can('crm.campaigns', 'create') && <Button variant="outline" onClick={() => w.edit('campaign')}><Plus />{uiText("New campaign")}</Button>}
          {w.can('crm.contacts', 'create') && <Button onClick={() => w.edit('contact')}><Plus />{uiText("New contact")}</Button>}
        </>} />
      <CrmTabs w={w} active="workflow" />
      <ol className="pipeline" aria-label={uiText("Sales lifecycle")}>
        {stages.map((s, i) => (
          <li key={s.type} className="pipeline-stage">
            <a href={`#/crm/${s.slug}`} className="pipeline-card">
              <span className="pipeline-top"><span className={`pipeline-icon stage-${s.type}`} aria-hidden="true"><s.icon /></span><span className="pipeline-step">{uiText("Step ")}{i + 1}</span></span>
              <span className="pipeline-count num">{d[TABLES[s.type]].length}</span>
              <span className="pipeline-title">{s.title}</span>
              <span className="pipeline-text">{s.text}</span>
              <span className="pipeline-stat">{s.stat}</span>
            </a>
            {i < stages.length - 1 && <ChevronRight className="pipeline-arrow" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <Alert tone="info" title={uiText("When you close a sale as won")}>{uiText("The contact, opportunity, pricing and activity history are preserved as a snapshot. An active Business Account is created or linked immediately, and the formal quotation follows Draft → Submitted → Approved → Accepted.")}</Alert>
      <div className="grid-2">
        {w.can('crm.leads') && <Card title={uiText("Qualified leads ready to convert")} description={uiText("Open a lead to convert it into an opportunity.")} flush>
          <DataTable rows={qualified} stateKey="crm-queue-leads" pageSize={10} onRowClick={l => w.show('lead', l.id)} columns={[
            { key: 'contact_id', header: uiText("Customer"), sortValue: l => customer(l.contact_id), cell: l => <span className="cell-stack"><span className="cell-title">{customer(l.contact_id) || l.id}</span><small className="id-text">{l.id}</small></span> },
            { key: 'rating', header: uiText("Rating"), cell: l => <StatusBadge value={l.rating} /> },
            { key: 'owner_id', header: uiText("Owner"), sortValue: l => w.lookup(l.owner_id), cell: l => w.lookup(l.owner_id) },
          ]} empty={<EmptyState compact title={uiText("No qualified leads")} description={uiText("Set a lead’s status to Qualified when it is ready for an opportunity.")} />} />
        </Card>}
        {w.can('crm.quotations') && <Card title={uiText("Quotations awaiting approval")} description={uiText("Highlighted rows are waiting for you.")} flush>
          <DataTable rows={pending} stateKey="crm-queue-quotes" pageSize={10} onRowClick={q => w.show('quotation', q.id)} rowClassName={q => JSON.parse(q.approval_chain)[q.approval_step]?.approver_id === w.actor ? 'row-mine' : undefined} columns={[
            { key: 'id', header: uiText("Quotation"), cell: q => <span className="cell-stack"><span className="cell-title">{customer(q.contact_id) || q.id}</span><small className="id-text">{q.id} {uiText("· Rev. ")}{q.revision}</small></span> },
            { key: 'total', header: uiText("Total"), numeric: true, sortValue: q => d.quote_revisions.find((v: Row) => v.quotation_id === q.id && v.revision === q.revision)?.total_cents, cell: q => <Money cents={d.quote_revisions.find((v: Row) => v.quotation_id === q.id && v.revision === q.revision)?.total_cents} currency={c} /> },
            { key: 'approval_step', header: uiText("Next approver"), sortValue: q => w.lookup(JSON.parse(q.approval_chain)[q.approval_step]?.approver_id), cell: q => { const id = JSON.parse(q.approval_chain)[q.approval_step]?.approver_id; return id === w.actor ? <strong>{uiText("You")}</strong> : w.lookup(id); } },
          ]} empty={<EmptyState compact title={uiText("Nothing awaiting approval")} description={uiText("Submitted quotations appear here until every step is approved.")} />} />
        </Card>}
        {w.can('crm.opportunities') && <Card title={uiText("Opportunities closing in the next 30 days")} description={uiText("Open deals by expected close date, including overdue ones.")} flush>
          <DataTable rows={closingSoon} stateKey="crm-queue-closing" pageSize={10} onRowClick={o => w.show('opportunity', o.id)} rowClassName={o => o.estimation < localDate() ? 'row-attention' : undefined} columns={[
            { key: 'title', header: uiText("Opportunity"), cell: o => <span className="cell-stack"><span className="cell-title">{o.title}</span><small>{customer(o.contact_id)}</small></span> },
            { key: 'estimation', header: uiText("Expected close"), cell: o => <span className={o.estimation < localDate() ? 'text-danger' : undefined}><DateText value={o.estimation} />{o.estimation < localDate() && <span className="sr-only"> {uiText("(overdue)")}</span>}</span> },
            { key: 'total_cents', header: uiText("Value"), numeric: true, cell: o => <Money cents={o.total_cents} currency={c} /> },
          ]} empty={<EmptyState compact title={uiText("No deals closing soon")} />} />
        </Card>}
        {w.can('crm.opportunities') && <Card title={uiText("Won opportunities ready for quotation")} description={uiText("Create the formal Sales Quotation for each won deal.")} flush>
          <DataTable rows={ready} stateKey="crm-queue-won" pageSize={10} onRowClick={o => w.show('opportunity', o.id)} columns={[
            { key: 'title', header: uiText("Opportunity"), cell: o => <span className="cell-stack"><span className="cell-title">{o.title}</span><small>{customer(o.contact_id)}</small></span> },
            { key: 'total_cents', header: uiText("Won value"), numeric: true, cell: o => <Money cents={o.total_cents} currency={c} /> },
            { key: 'account', header: uiText("Business Account"), sortable: false, cell: o => { const sale = d.won_sales.find((s: Row) => s.opportunity_id === o.id); return sale?.account_id ? <button type="button" className="text-link" onClick={() => w.show('account', sale.account_id)}>{sale.account_id}</button> : null; } },
          ]} empty={<EmptyState compact title={uiText("Every won deal has a quotation")} description={uiText("Close an opportunity as won to create its Sales Quotation.")} />} />
        </Card>}
      </div>
    </>
  );
}
