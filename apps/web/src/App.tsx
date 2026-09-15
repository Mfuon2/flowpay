import { useEffect, useState, type ReactNode } from "react";

import {
  ApiError,
  api,
  mutationHeaders,
  organisationId,
  setOrganisationId,
} from "./api.ts";
import type {
  DashboardData,
  EscrowDetail,
  EscrowListItem,
  OperationsData,
  SettlementDetail,
  SettlementListItem,
} from "./types.ts";

const navigation = [
  ["/", "Overview"],
  ["/customers", "Customers"],
  ["/jobs", "Jobs"],
  ["/participants", "People"],
  ["/services", "Services"],
  ["/quotes", "Quotes"],
  ["/invoices", "Invoices"],
  ["/payments", "Payments"],
  ["/settlement-rules", "Rules"],
  ["/approval-policies", "Approval policies"],
  ["/approvals", "Approvals"],
  ["/settlements", "Settlements"],
  ["/escrow", "Escrow"],
  ["/settlement-accounts", "Settlement accounts"],
  ["/accounts", "Accounts"],
  ["/journal-entries", "Journal"],
  ["/reconciliations", "Reconciliation"],
  ["/operations", "Operations"],
  ["/audit-events", "Audit"],
] as const;

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = (to: string) => {
    history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const detailId = path.match(/^\/settlements\/([^/]+)$/)?.[1];
  const escrowDetailId = path.match(/^\/escrow\/([^/]+)$/)?.[1];
  let content: ReactNode;
  if (detailId)
    content = <SettlementDetailScreen id={decodeURIComponent(detailId)} />;
  else if (escrowDetailId)
    content = <EscrowDetailScreen id={decodeURIComponent(escrowDetailId)} />;
  else if (path === "/") content = <Dashboard />;
  else if (path === "/settlements")
    content = <Settlements onNavigate={navigate} />;
  else if (path === "/escrow") content = <Escrow onNavigate={navigate} />;
  else if (path === "/operations")
    content = <Operations onNavigate={navigate} />;
  else content = <CollectionScreen path={path} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("/")}>
          <img src="/flowpay-mark.svg" alt="" />
          <span>
            <strong>QeSuite</strong>
            <small>FlowPay</small>
          </span>
        </button>
        <nav aria-label="Primary navigation">
          {navigation.map(([to, label]) => (
            <button
              className={
                path === to ||
                (to === "/settlements" && detailId) ||
                (to === "/escrow" && escrowDetailId)
                  ? "active"
                  : ""
              }
              key={to}
              onClick={() => navigate(to)}
            >
              <span className="nav-mark" />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          Operational controls active
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">QeSuite FlowPay</span>
            <strong>Business happens. Money follows.</strong>
          </div>
          <OrganisationControl />
        </header>
        <main>{content}</main>
      </div>
    </div>
  );
}

function OrganisationControl() {
  const [value, setValue] = useState(organisationId());
  return (
    <label className="org-control">
      <span>Organisation</span>
      <input
        value={value}
        placeholder="Organisation ID"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          setOrganisationId(value);
          location.reload();
        }}
      />
    </label>
  );
}

function Dashboard() {
  const state = useApi<DashboardData>("/dashboard");
  return (
    <Page
      title="Overview"
      description="Operational events, settlement controls, and financial completion in one place."
    >
      <Loadable state={state}>
        {(data) => (
          <>
            <section className="metrics">
              <Metric label="Active customers" value={data.customers} />
              <Metric label="Open jobs" value={data.openJobs} />
              <Metric label="Open invoices" value={data.openInvoices} />
              <Metric
                label="Awaiting approval"
                value={data.pendingApprovals}
                attention={data.pendingApprovals > 0}
              />
            </section>
            <section className="panel">
              <PanelHeading
                title="Settlement control"
                subtitle="Current workload by financial state"
              />
              <div className="state-grid">
                {data.settlementsByState.length ? (
                  data.settlementsByState.map((item) => (
                    <div className="state-row" key={item.state}>
                      <Status value={item.state} />
                      <strong>{item.count}</strong>
                    </div>
                  ))
                ) : (
                  <Empty message="No settlements have been created yet." />
                )}
              </div>
            </section>
            <section className="flow-strip" aria-label="FlowPay process">
              <span>Business event</span>
              <i>→</i>
              <span>Rule</span>
              <i>→</i>
              <span>Approval</span>
              <i>→</i>
              <span>Settlement</span>
              <i>→</i>
              <span>Accounting</span>
              <i>→</i>
              <span>Reconciliation</span>
            </section>
          </>
        )}
      </Loadable>
    </Page>
  );
}

function Operations({ onNavigate }: { onNavigate: (path: string) => void }) {
  const state = useApi<OperationsData>("/operations");
  return (
    <Page
      title="Operations"
      description="Financial work requiring attention remains visible and linked to its business evidence."
    >
      <Loadable state={state}>
        {(data) => {
          const attention = data.items.filter(
            (item) => item.severity === "CRITICAL" && item.count > 0,
          ).length;
          return (
            <>
              <section className="metrics">
                <Metric label="Attention areas" value={attention} attention />
                <Metric
                  label="Awaiting confirmation"
                  value={
                    data.items.find((item) => item.id === "provider")?.count ??
                    0
                  }
                />
                <Metric
                  label="Unknown outcomes"
                  value={
                    data.items.find((item) => item.id === "unknown")?.count ?? 0
                  }
                  attention={
                    (data.items.find((item) => item.id === "unknown")?.count ??
                      0) > 0
                  }
                />
                <Metric
                  label="Reconciliation exceptions"
                  value={
                    data.items.find((item) => item.id === "reconciliation")
                      ?.count ?? 0
                  }
                  attention={
                    (data.items.find((item) => item.id === "reconciliation")
                      ?.count ?? 0) > 0
                  }
                />
              </section>
              <section className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Control</th>
                      <th>Count</th>
                      <th>Oldest</th>
                      <th>Priority</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.label}</strong>
                        </td>
                        <td>{item.count}</td>
                        <td>
                          {item.oldestAt ? formatDate(item.oldestAt) : "—"}
                        </td>
                        <td>
                          <Status
                            value={
                              item.count === 0
                                ? "CLEAR"
                                : item.severity === "CRITICAL"
                                  ? "ATTENTION"
                                  : "PENDING"
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="button secondary"
                            onClick={() => onNavigate(item.path)}
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <p className="operations-generated">
                Snapshot {formatDate(data.generatedAt)}. Provider secrets and
                raw external payloads are never exposed here.
              </p>
            </>
          );
        }}
      </Loadable>
    </Page>
  );
}

function Settlements({ onNavigate }: { onNavigate: (path: string) => void }) {
  const state = useApi<{ items: readonly SettlementListItem[] }>(
    "/settlements",
  );
  return (
    <Page
      title="Settlements"
      description="Every financial decision from trigger through reconciliation."
    >
      <Loadable state={state}>
        {({ items }) =>
          items.length ? (
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Settlement</th>
                    <th>Created</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() =>
                        onNavigate(
                          `/settlements/${encodeURIComponent(item.id)}`,
                        )
                      }
                      tabIndex={0}
                    >
                      <td>
                        <strong>{shortId(item.id)}</strong>
                      </td>
                      <td>{formatDate(item.created_at)}</td>
                      <td>
                        {formatMoney(
                          item.amount_atomic,
                          item.asset_scale,
                          item.asset_code,
                        )}
                      </td>
                      <td>
                        <Status value={item.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty message="No settlements match this organisation." />
          )
        }
      </Loadable>
    </Page>
  );
}

function Escrow({ onNavigate }: { onNavigate: (path: string) => void }) {
  const state = useApi<{ items: readonly EscrowListItem[] }>("/escrow");
  return (
    <Page
      title="Escrow"
      description="Controlled funding and milestone releases driven by verified business events."
    >
      <CreateEscrowPanel />
      <Loadable state={state}>
        {({ items }) =>
          items.length ? (
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Arrangement</th>
                    <th>Funding</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() =>
                        onNavigate(`/escrow/${encodeURIComponent(item.id)}`)
                      }
                      tabIndex={0}
                    >
                      <td>
                        <strong>{item.name}</strong>
                      </td>
                      <td>{shortId(item.funding_payment_id)}</td>
                      <td>
                        {formatMoney(
                          item.amount_atomic,
                          item.asset_scale,
                          item.asset_code,
                        )}
                      </td>
                      <td>
                        <Status value={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty message="No escrow arrangements have been created yet." />
          )
        }
      </Loadable>
    </Page>
  );
}

function EscrowDetailScreen({ id }: { id: string }) {
  const state = useApi<EscrowDetail>(`/escrow/${encodeURIComponent(id)}`);
  return (
    <Page
      title="Escrow detail"
      description="Funding, verification, settlement, and release evidence in one control view."
    >
      <Loadable state={state}>
        {(data) => <EscrowEvidence data={data} />}
      </Loadable>
    </Page>
  );
}

function EscrowEvidence({ data }: { data: EscrowDetail }) {
  const { escrow } = data;
  return (
    <div className="detail-grid">
      <section className="panel hero-card">
        <div>
          <span className="eyebrow">Escrow arrangement</span>
          <h2>{escrow.name}</h2>
          <p>{escrow.funding_reference}</p>
        </div>
        <div className="hero-amount">
          <strong>
            {formatMoney(
              escrow.amount_atomic,
              escrow.asset_scale,
              escrow.asset_code,
            )}
          </strong>
          <Status value={escrow.state} />
        </div>
      </section>
      <section className="panel">
        <PanelHeading
          title="Control"
          subtitle="Explicit state transitions preserve financial evidence"
        />
        <Definition
          rows={[
            ["Funding payment", shortId(escrow.funding_payment_id)],
            ["Funding status", humanize(escrow.funding_status)],
            ["State version", String(escrow.state_version)],
            ["Created", formatDate(escrow.created_at)],
          ]}
        />
        <EscrowTransitionControl escrowId={escrow.id} state={escrow.state} />
      </section>
      <section className="panel full-span">
        <PanelHeading
          title="Milestones"
          subtitle="Verification emits a generic business event; release waits for confirmed settlement"
        />
        <div className="card-list">
          {data.milestones.map((milestone, index) => {
            const priorVerified = data.milestones
              .slice(0, index)
              .every((item) => item.verification_id !== null);
            return (
              <article className="record-card" key={milestone.id}>
                <div>
                  <strong>
                    {milestone.position + 1}. {milestone.name}
                  </strong>
                  <small>{humanize(milestone.verification_event_type)}</small>
                </div>
                <strong>
                  {formatMoney(
                    milestone.release_amount_atomic,
                    milestone.asset_scale,
                    milestone.asset_code,
                  )}
                </strong>
                <Status
                  value={
                    milestone.released_at
                      ? "RELEASED"
                      : (milestone.settlement_state ??
                        (milestone.verified_at ? "VERIFIED" : "PENDING"))
                  }
                />
                {!milestone.verified_at &&
                priorVerified &&
                (escrow.state === "FUNDED" ||
                  escrow.state === "PARTIALLY_RELEASED") ? (
                  <VerifyMilestoneControl
                    escrowId={escrow.id}
                    milestoneId={milestone.id}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
      <section className="panel">
        <PanelHeading
          title="State history"
          subtitle="Append-only transitions"
        />
        {data.transitions.length ? (
          <div className="timeline">
            {data.transitions.map((transition) => (
              <div key={transition.id}>
                <span />
                <div>
                  <strong>{humanize(transition.action)}</strong>
                  <small>
                    {humanize(transition.from_state)} →{" "}
                    {humanize(transition.to_state)} ·{" "}
                    {formatDate(transition.occurred_at)}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty message="No state transitions yet." />
        )}
      </section>
      <section className="panel">
        <PanelHeading title="Audit" subtitle="Who did what and when" />
        {data.audit.length ? (
          <div className="timeline">
            {data.audit.map((event) => (
              <div key={event.id}>
                <span />
                <div>
                  <strong>{humanize(event.action)}</strong>
                  <small>
                    {event.actor_id} · {formatDate(event.occurred_at)}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty message="No audit evidence yet." />
        )}
      </section>
    </div>
  );
}

function SettlementDetailScreen({ id }: { id: string }) {
  const state = useApi<SettlementDetail>(
    `/settlements/${encodeURIComponent(id)}`,
  );
  return (
    <Page
      title={`Settlement ${shortId(id)}`}
      description="The complete business, approval, execution, accounting, and reconciliation record."
    >
      <Loadable state={state}>
        {(data) => <SettlementRecord data={data} />}
      </Loadable>
    </Page>
  );
}

function SettlementRecord({ data }: { data: SettlementDetail }) {
  const settlement = data.settlement;
  const approval = data.approvals[0];
  return (
    <div className="detail-grid">
      <section className="panel hero-record">
        <div>
          <span className="eyebrow">Settlement record</span>
          <h2>{shortId(settlement.id)}</h2>
        </div>
        <div className="hero-amount">
          <strong>
            {formatMoney(
              settlement.amount_atomic,
              settlement.asset_scale,
              settlement.asset_code,
            )}
          </strong>
          <Status value={settlement.state} />
        </div>
      </section>
      <section className="panel">
        <PanelHeading
          title="Trigger and rule"
          subtitle="Why this settlement exists"
        />
        <Definition
          rows={[
            ["Business event", humanize(settlement.event_type)],
            ["Rule", `${settlement.rule_name} · v${settlement.rule_version}`],
            ["Correlation", shortId(settlement.correlation_id)],
          ]}
        />
      </section>
      <section className="panel span-2">
        <PanelHeading
          title="Distribution"
          subtitle="Exact beneficiary entitlements"
        />
        <div className="distribution-list">
          {data.distributions.map((item) => (
            <div key={item.id}>
              <div>
                <strong>{item.beneficiary_name}</strong>
                <small>{humanize(item.calculation_kind)}</small>
              </div>
              <div>
                <strong>
                  {formatMoney(
                    item.amount_atomic,
                    item.asset_scale,
                    item.asset_code,
                  )}
                </strong>
                <Status value={item.state} />
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <PanelHeading
          title="Approval control"
          subtitle="Policy and human decisions"
        />
        {approval ? (
          <>
            <Status value={approval.status} />
            <Definition
              rows={[
                ["Policy", safePolicyLabel(approval.requirements_json)],
                [
                  "Decisions",
                  String(safeJsonArray(approval.decisions_json).length),
                ],
              ]}
            />
            <SettlementActions
              settlementId={settlement.id}
              settlementState={settlement.state}
              policyMode={safePolicyMode(approval.requirements_json)}
            />
          </>
        ) : (
          <Empty message="No approval record." />
        )}
      </section>
      <section className="panel">
        <PanelHeading
          title="Reconciliation"
          subtitle="Provider and accounting agreement"
        />
        <div className="state-grid">
          {data.reconciliations.length ? (
            data.reconciliations.map((item) => (
              <div className="state-row" key={item.id}>
                <Status value={item.status} />
                <span>{shortId(item.id)}</span>
              </div>
            ))
          ) : (
            <Empty message="Reconciliation has not completed." />
          )}
        </div>
      </section>
      <section className="panel span-2">
        <PanelHeading
          title="Execution"
          subtitle="Provider and network evidence"
        />
        {data.providerTransactions.length ? (
          <div className="execution-grid">
            {data.providerTransactions.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.beneficiary_name}</strong>
                  <Status value={item.status} />
                </div>
                <Definition
                  rows={[
                    ["Provider", item.provider],
                    ["Network", item.network ?? "—"],
                    [
                      "Provider transaction",
                      item.provider_transaction_id
                        ? shortId(item.provider_transaction_id)
                        : "—",
                    ],
                    [
                      "Network reference",
                      item.network_transaction_reference
                        ? shortId(item.network_transaction_reference)
                        : "—",
                    ],
                  ]}
                />
              </article>
            ))}
          </div>
        ) : (
          <Empty message="Provider execution has not started." />
        )}
        {data.settlementAttempts
          .filter((attempt) => attempt.status === "OUTCOME_UNKNOWN")
          .map((attempt) => (
            <SettlementRecoveryControl
              key={attempt.id}
              settlementId={settlement.id}
              attempt={attempt}
            />
          ))}
      </section>
      <section className="panel span-2">
        <PanelHeading
          title="Accounting entries"
          subtitle="Balanced postings linked to this settlement"
        />
        {data.journalEntries.length ? (
          <div className="journal-list">
            {data.journalEntries.map((entry) => (
              <article key={entry.id}>
                <div>
                  <strong>{humanize(entry.posting_purpose)}</strong>
                  <Status value={entry.status} />
                </div>
                <small>
                  {safeJsonArray(entry.lines_json).length} lines ·{" "}
                  {entry.posted_at ? formatDate(entry.posted_at) : "Not posted"}
                </small>
              </article>
            ))}
          </div>
        ) : (
          <Empty message="No accounting entry has been posted." />
        )}
      </section>
      <section className="panel span-2">
        <PanelHeading
          title="Audit timeline"
          subtitle="Append-only explanation of every decision"
        />
        <ol className="timeline">
          {data.audit.map((item) => (
            <li key={item.id}>
              <span className="timeline-mark" />
              <div>
                <strong>{humanize(item.action)}</strong>
                <small>
                  {formatDate(item.occurred_at)} · {item.actor_id}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function SettlementRecoveryControl({
  settlementId,
  attempt,
}: {
  settlementId: string;
  attempt: SettlementDetail["settlementAttempts"][number];
}) {
  const [reason, setReason] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async () => {
    if (!reason.trim() || !evidenceReference.trim()) {
      setError("A reason and provider verification reference are required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `/settlements/${encodeURIComponent(settlementId)}/recovery-decisions`,
        {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            action: "RETRY_CONFIRMED_NOT_SUBMITTED",
            attemptId: attempt.id,
            reason: reason.trim(),
            evidenceReference: evidenceReference.trim(),
          }),
        },
      );
      location.reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Recovery was not recorded.",
      );
      setBusy(false);
    }
  };
  return (
    <div className="action-box">
      <strong>Unknown transfer outcome · {attempt.beneficiary_name}</strong>
      <small>
        Attempt {attempt.attempt_number} is frozen. Verify with the provider
        that no transfer exists before authorizing another attempt.
      </small>
      <label>
        <span>Provider verification reference</span>
        <input
          value={evidenceReference}
          onChange={(event) => setEvidenceReference(event.target.value)}
          placeholder="Support case, search record, or signed evidence ID"
        />
      </label>
      <label>
        <span>Recovery reason</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Explain how non-submission was verified"
        />
      </label>
      {error ? <p className="inline-error">{error}</p> : null}
      <div>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void recover()}
        >
          {busy ? "Recording…" : "Authorize retry"}
        </button>
      </div>
    </div>
  );
}

function SettlementActions({
  settlementId,
  settlementState,
  policyMode,
}: {
  settlementId: string;
  settlementState: string;
  policyMode: string;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (settlementState !== "PENDING_APPROVAL") return null;
  const manual = policyMode === "MANUAL";
  const act = async (action: "APPROVE" | "REJECT" | "RELEASE" | "CANCEL") => {
    if ((action === "REJECT" || action === "CANCEL") && !reason.trim()) {
      setError("A reason is required for rejection or cancellation.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `/settlements/${encodeURIComponent(settlementId)}/${manual ? "manual-control" : "approval-decisions"}`,
        {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify(
            manual
              ? { action, reason: reason.trim() || undefined }
              : { decision: action, reason: reason.trim() || undefined },
          ),
        },
      );
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
      setBusy(false);
    }
  };
  return (
    <div className="action-box">
      <label>
        <span>Reason or note</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Add supporting context"
        />
      </label>
      {error ? <p className="inline-error">{error}</p> : null}
      <div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void act(manual ? "CANCEL" : "REJECT")}
        >
          {manual ? "Cancel" : "Reject"}
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void act(manual ? "RELEASE" : "APPROVE")}
        >
          {busy ? "Recording…" : manual ? "Release" : "Approve"}
        </button>
      </div>
    </div>
  );
}

const collectionNames: Record<
  string,
  {
    title: string;
    endpoint: string;
    description: string;
    createKind?:
      | "CUSTOMER"
      | "PARTICIPANT"
      | "JOB"
      | "SERVICE"
      | "QUOTE"
      | "INVOICE"
      | "PAYMENT"
      | "APPROVAL_POLICY"
      | "SETTLEMENT_RULE";
  }
> = {
  "/customers": {
    title: "Customers",
    endpoint: "/customers",
    description: "Business counterparties connected to jobs and invoices.",
    createKind: "CUSTOMER",
  },
  "/jobs": {
    title: "Jobs",
    endpoint: "/jobs",
    description: "Operational work that can produce verified business events.",
    createKind: "JOB",
  },
  "/participants": {
    title: "People and participants",
    endpoint: "/participants",
    description:
      "Employees, contractors, suppliers, and referrers who can receive entitlements.",
    createKind: "PARTICIPANT",
  },
  "/services": {
    title: "Products and services",
    endpoint: "/services",
    description: "Reusable commercial items with exact unit prices.",
    createKind: "SERVICE",
  },
  "/quotes": {
    title: "Quotes",
    endpoint: "/quotes",
    description:
      "Customer proposals whose controlled approval can emit a business event.",
    createKind: "QUOTE",
  },
  "/invoices": {
    title: "Invoices",
    endpoint: "/invoices",
    description: "Customer obligations and their payment state.",
    createKind: "INVOICE",
  },
  "/payments": {
    title: "Payments",
    endpoint: "/payments",
    description: "Confirmed receipts that can activate settlement rules.",
    createKind: "PAYMENT",
  },
  "/settlement-rules": {
    title: "Settlement rules",
    endpoint: "/settlement-rules",
    description:
      "Versioned commercial rules connecting verified events to beneficiary entitlements.",
    createKind: "SETTLEMENT_RULE",
  },
  "/approval-policies": {
    title: "Approval policies",
    endpoint: "/approval-policies",
    description:
      "Versioned controls determining when settlement needs human review.",
    createKind: "APPROVAL_POLICY",
  },
  "/approvals": {
    title: "Approvals",
    endpoint: "/approvals",
    description:
      "Financial decisions awaiting or carrying documented human control.",
  },
  "/settlement-accounts": {
    title: "Settlement accounts",
    endpoint: "/settlement-accounts",
    description:
      "Provider-neutral funding sources used by reviewed settlement policies.",
  },
  "/escrow": {
    title: "Escrow",
    endpoint: "/escrow",
    description:
      "Controlled funding and milestone releases linked to verified business events.",
  },
  "/accounts": {
    title: "Accounts",
    endpoint: "/accounts",
    description: "The organisation's exact-precision chart of accounts.",
  },
  "/journal-entries": {
    title: "Journal entries",
    endpoint: "/journal-entries",
    description: "Immutable, balanced financial postings.",
  },
  "/reconciliations": {
    title: "Reconciliation",
    endpoint: "/reconciliations",
    description: "Agreement between entitlement, provider, and ledger truth.",
  },
  "/audit-events": {
    title: "Audit",
    endpoint: "/audit-events",
    description:
      "Append-only evidence explaining business events, decisions, execution, and accounting.",
  },
};

function CollectionScreen({ path }: { path: string }) {
  const config = collectionNames[path];
  if (!config)
    return (
      <Page title="Not found" description="This page does not exist.">
        <Empty message="Choose a module from the navigation." />
      </Page>
    );
  return <GenericCollection config={config} />;
}

function GenericCollection({
  config,
}: {
  config: {
    title: string;
    endpoint: string;
    description: string;
    createKind?:
      | "CUSTOMER"
      | "PARTICIPANT"
      | "JOB"
      | "SERVICE"
      | "QUOTE"
      | "INVOICE"
      | "PAYMENT"
      | "APPROVAL_POLICY"
      | "SETTLEMENT_RULE";
  };
}) {
  const state = useApi<{ items: readonly Record<string, unknown>[] }>(
    config.endpoint,
  );
  return (
    <Page title={config.title} description={config.description}>
      <>
        {config.createKind === "JOB" ? (
          <CreateJobPanel />
        ) : config.createKind === "SERVICE" ? (
          <CreateServicePanel />
        ) : config.createKind === "QUOTE" ? (
          <CreateQuotePanel />
        ) : config.createKind === "INVOICE" ? (
          <CreateInvoicePanel />
        ) : config.createKind === "PAYMENT" ? (
          <CreatePaymentPanel />
        ) : config.createKind === "APPROVAL_POLICY" ? (
          <CreateApprovalPolicyPanel />
        ) : config.createKind === "SETTLEMENT_RULE" ? (
          <CreateSettlementRulePanel />
        ) : config.createKind ? (
          <CreatePartyPanel kind={config.createKind} />
        ) : null}
        <Loadable state={state}>
          {({ items }) =>
            items.length ? (
              <div className="card-list">
                {items.map((item, index) => (
                  <article
                    className="panel record-card"
                    key={displayValue(item.id, String(index))}
                  >
                    <div>
                      <strong>{collectionPrimaryLabel(item)}</strong>
                      <small>{humanize(collectionSecondaryLabel(item))}</small>
                    </div>
                    {"amount_atomic" in item ? (
                      <strong>
                        {formatMoney(
                          displayValue(item.amount_atomic, "0"),
                          numericValue(item.asset_scale),
                          displayValue(item.asset_code, ""),
                        )}
                      </strong>
                    ) : (
                      <Status value={displayValue(item.status, "RECORDED")} />
                    )}
                    {config.endpoint === "/payments" &&
                    item.status === "PENDING" &&
                    typeof item.id === "string" ? (
                      <ConfirmPaymentButton paymentId={item.id} />
                    ) : null}
                    {config.endpoint === "/invoices" &&
                    item.status === "ISSUED" &&
                    typeof item.id === "string" ? (
                      <VoidInvoiceControl invoiceId={item.id} />
                    ) : null}
                    {config.endpoint === "/jobs" &&
                    typeof item.id === "string" &&
                    (item.status === "DRAFT" ||
                      item.status === "IN_PROGRESS") ? (
                      <JobTransitionControls
                        jobId={item.id}
                        status={item.status}
                      />
                    ) : null}
                    {config.endpoint === "/quotes" &&
                    typeof item.id === "string" &&
                    (item.status === "DRAFT" || item.status === "ISSUED") ? (
                      <QuoteTransitionControls
                        quoteId={item.id}
                        status={item.status}
                      />
                    ) : null}
                    {(config.endpoint === "/approval-policies" ||
                      config.endpoint === "/settlement-rules") &&
                    typeof item.id === "string" &&
                    (item.status === "DRAFT" || item.status === "ACTIVE") ? (
                      <ConfigurationTransitionButton
                        endpoint={config.endpoint}
                        configurationId={item.id}
                        status={item.status}
                      />
                    ) : null}
                    {config.endpoint === "/reconciliations" &&
                    item.status === "MISMATCHED" &&
                    typeof item.id === "string" ? (
                      <FinancialCorrectionControl
                        endpoint={`/reconciliations/${encodeURIComponent(item.id)}/resolutions`}
                        actionLabel="Resolve mismatch"
                        evidenceLabel="Resolution evidence reference"
                      />
                    ) : null}
                    {config.endpoint === "/journal-entries" &&
                    item.status === "POSTED" &&
                    item.reversal_of_id === null &&
                    typeof item.id === "string" ? (
                      <FinancialCorrectionControl
                        endpoint={`/journal-entries/${encodeURIComponent(item.id)}/reversals`}
                        actionLabel="Post reversal"
                        evidenceLabel="Reversal evidence reference"
                      />
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <Empty
                message={`No ${config.title.toLowerCase()} records yet.`}
              />
            )
          }
        </Loadable>
      </>
    </Page>
  );
}

type CustomerOption = Readonly<{ id: string; display_name: string }>;

function CreateServicePanel() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [asset, setAsset] = useState<"USD" | "USDC">("USD");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    try {
      if (!name.trim()) throw new TypeError("Service name is required.");
      const scale = asset === "USDC" ? 6 : 2;
      setBusy(true);
      setError(undefined);
      await api("/services", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          assetCode: asset,
          assetScale: scale,
          unitPriceAtomic: decimalToAtomic(price, scale),
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Add product or service</strong>
          <small>Record an exact reusable commercial unit price.</small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <div className="create-fields">
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>Currency</span>
            <select
              value={asset}
              onChange={(event) =>
                setAsset(event.target.value as "USD" | "USDC")
              }
            >
              <option value="USD">USD</option>
              <option value="USDC">USDC</option>
            </select>
          </label>
          <label>
            <span>Unit price</span>
            <input
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="100.00"
            />
          </label>
          <label className="wide-field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {error ? <p className="inline-error">{error}</p> : null}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Save service"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type ServiceOption = Readonly<{
  id: string;
  name: string;
  asset_code: string;
}>;

type QuoteLineDraft = Readonly<{
  key: string;
  serviceId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}>;

function CreateQuotePanel() {
  const customers = useApi<{ items: readonly CustomerOption[] }>("/customers");
  const jobs = useApi<{ items: readonly JobOption[] }>("/jobs");
  const services = useApi<{ items: readonly ServiceOption[] }>("/services");
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [reference, setReference] = useState("");
  const [asset, setAsset] = useState<"USD" | "USDC">("USD");
  const [lines, setLines] = useState<readonly QuoteLineDraft[]>([
    {
      key: crypto.randomUUID(),
      serviceId: "",
      description: "",
      quantity: "1",
      unitPrice: "",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const updateLine = (
    key: string,
    field: keyof Omit<QuoteLineDraft, "key">,
    value: string,
  ) =>
    setLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, [field]: value } : line,
      ),
    );
  const submit = async () => {
    try {
      if (!customerId || !reference.trim())
        throw new TypeError("Customer and quote reference are required.");
      const scale = asset === "USDC" ? 6 : 2;
      const parsedLines = lines.map((line) => {
        const quantity = decimalQuantity(line.quantity);
        if (!line.description.trim())
          throw new TypeError("Every quote line needs a description.");
        return {
          serviceId: line.serviceId || undefined,
          description: line.description.trim(),
          quantityAtomic: quantity.atomic,
          quantityScale: quantity.scale,
          unitPriceAtomic: decimalToAtomic(line.unitPrice, scale),
        };
      });
      setBusy(true);
      setError(undefined);
      await api("/quotes", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          customerId,
          jobId: jobId || undefined,
          reference: reference.trim(),
          assetCode: asset,
          assetScale: scale,
          lines: parsedLines,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Create quote</strong>
          <small>
            Build an exact proposal before controlled issue and approval.
          </small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <Loadable state={customers}>
          {({ items: customerItems }) => (
            <Loadable state={jobs}>
              {({ items: jobItems }) => (
                <Loadable state={services}>
                  {({ items: serviceItems }) => (
                    <div className="create-fields">
                      <label>
                        <span>Customer</span>
                        <select
                          value={customerId}
                          onChange={(event) => {
                            setCustomerId(event.target.value);
                            setJobId("");
                          }}
                        >
                          <option value="">Select customer</option>
                          {customerItems.map((customer) => (
                            <option key={customer.id} value={customer.id}>
                              {customer.display_name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Job (optional)</span>
                        <select
                          value={jobId}
                          onChange={(event) => setJobId(event.target.value)}
                        >
                          <option value="">No linked job</option>
                          {jobItems
                            .filter((job) => job.customer_id === customerId)
                            .map((job) => (
                              <option key={job.id} value={job.id}>
                                {job.reference}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        <span>Quote reference</span>
                        <input
                          value={reference}
                          onChange={(event) => setReference(event.target.value)}
                          placeholder="QTE-001"
                        />
                      </label>
                      <label>
                        <span>Currency</span>
                        <select
                          value={asset}
                          onChange={(event) =>
                            setAsset(event.target.value as "USD" | "USDC")
                          }
                        >
                          <option value="USD">USD</option>
                          <option value="USDC">USDC</option>
                        </select>
                      </label>
                      <div className="wide-field beneficiary-builder">
                        <div>
                          <strong>Quote lines</strong>
                          <button
                            className="button quiet"
                            onClick={() =>
                              setLines((current) => [
                                ...current,
                                {
                                  key: crypto.randomUUID(),
                                  serviceId: "",
                                  description: "",
                                  quantity: "1",
                                  unitPrice: "",
                                },
                              ])
                            }
                          >
                            Add line
                          </button>
                        </div>
                        {lines.map((line, index) => (
                          <div className="quote-line-row" key={line.key}>
                            <span>{index + 1}</span>
                            <select
                              value={line.serviceId}
                              onChange={(event) =>
                                updateLine(
                                  line.key,
                                  "serviceId",
                                  event.target.value,
                                )
                              }
                            >
                              <option value="">Custom item</option>
                              {serviceItems
                                .filter(
                                  (service) => service.asset_code === asset,
                                )
                                .map((service) => (
                                  <option key={service.id} value={service.id}>
                                    {service.name}
                                  </option>
                                ))}
                            </select>
                            <input
                              value={line.description}
                              onChange={(event) =>
                                updateLine(
                                  line.key,
                                  "description",
                                  event.target.value,
                                )
                              }
                              placeholder="Description"
                            />
                            <input
                              inputMode="decimal"
                              value={line.quantity}
                              onChange={(event) =>
                                updateLine(
                                  line.key,
                                  "quantity",
                                  event.target.value,
                                )
                              }
                              placeholder="Qty"
                            />
                            <input
                              inputMode="decimal"
                              value={line.unitPrice}
                              onChange={(event) =>
                                updateLine(
                                  line.key,
                                  "unitPrice",
                                  event.target.value,
                                )
                              }
                              placeholder="Unit price"
                            />
                            {lines.length > 1 ? (
                              <button
                                className="button quiet"
                                onClick={() =>
                                  setLines((current) =>
                                    current.filter(
                                      (item) => item.key !== line.key,
                                    ),
                                  )
                                }
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      {error ? <p className="inline-error">{error}</p> : null}
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void submit()}
                      >
                        {busy ? "Saving…" : "Save draft"}
                      </button>
                    </div>
                  )}
                </Loadable>
              )}
            </Loadable>
          )}
        </Loadable>
      ) : null}
    </section>
  );
}

function QuoteTransitionControls({
  quoteId,
  status,
}: {
  quoteId: string;
  status: "DRAFT" | "ISSUED";
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (action: "ISSUE" | "APPROVE" | "REJECT" | "EXPIRE") => {
    if (action === "REJECT" && !reason.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(`/quotes/${encodeURIComponent(quoteId)}/transitions`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ action, reason: reason.trim() || undefined }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
      setBusy(false);
    }
  };
  return (
    <div className="record-action vertical-action">
      {status === "ISSUED" ? (
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason if rejecting"
        />
      ) : null}
      {error ? <small className="inline-error">{error}</small> : null}
      <div>
        {status === "DRAFT" ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void submit("ISSUE")}
          >
            Issue quote
          </button>
        ) : (
          <>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void submit("EXPIRE")}
            >
              Expire
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void submit("REJECT")}
            >
              Reject
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void submit("APPROVE")}
            >
              Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CreateJobPanel() {
  const customers = useApi<{ items: readonly CustomerOption[] }>("/customers");
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!customerId || !reference.trim() || !title.trim()) {
      setError("Customer, reference, and title are required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api("/jobs", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          customerId,
          reference: reference.trim(),
          title: title.trim(),
          description: description.trim() || undefined,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Add job</strong>
          <small>Create operational work without settlement coupling.</small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <Loadable state={customers}>
          {({ items }) =>
            items.length ? (
              <div className="create-fields">
                <label>
                  <span>Customer</span>
                  <select
                    value={customerId}
                    onChange={(event) => setCustomerId(event.target.value)}
                  >
                    <option value="">Select customer</option>
                    {items.map((customer) => (
                      <option value={customer.id} key={customer.id}>
                        {customer.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Reference</span>
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="JOB-00183"
                  />
                </label>
                <label>
                  <span>Title</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Describe the work"
                  />
                </label>
                <label className="wide-field">
                  <span>Description</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                {error ? <p className="inline-error">{error}</p> : null}
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  {busy ? "Saving…" : "Save as draft"}
                </button>
              </div>
            ) : (
              <Empty message="Create an active customer before adding a job." />
            )
          }
        </Loadable>
      ) : null}
    </section>
  );
}

function JobTransitionControls({
  jobId,
  status,
}: {
  jobId: string;
  status: "DRAFT" | "IN_PROGRESS";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const action = status === "DRAFT" ? "START" : "COMPLETE";
  const submit = async (requestedAction: "START" | "COMPLETE" | "CANCEL") => {
    if (requestedAction === "CANCEL" && !cancelReason.trim()) {
      setError("A reason is required to cancel a job.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(`/jobs/${encodeURIComponent(jobId)}/transitions`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          action: requestedAction,
          reason:
            requestedAction === "CANCEL" ? cancelReason.trim() : undefined,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
      setBusy(false);
    }
  };
  return (
    <div className="record-action vertical-action">
      {cancelOpen ? (
        <input
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
          placeholder="Reason for cancellation"
          aria-label="Reason for cancelling job"
        />
      ) : null}
      {error ? <small className="inline-error">{error}</small> : null}
      <div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            cancelOpen ? void submit("CANCEL") : setCancelOpen(true)
          }
        >
          {cancelOpen ? "Confirm cancellation" : "Cancel"}
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void submit(action)}
        >
          {busy
            ? "Recording…"
            : status === "DRAFT"
              ? "Start job"
              : "Complete job"}
        </button>
      </div>
    </div>
  );
}

type JobOption = Readonly<{
  id: string;
  customer_id: string;
  reference: string;
  status: string;
}>;

function CreateInvoicePanel() {
  const customers = useApi<{ items: readonly CustomerOption[] }>("/customers");
  const jobs = useApi<{ items: readonly JobOption[] }>("/jobs");
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState<"USD" | "USDC">("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    try {
      if (!customerId || !reference.trim()) {
        throw new TypeError("Customer and invoice reference are required.");
      }
      const scale = asset === "USDC" ? 6 : 2;
      const totalAtomic = decimalToAtomic(amount, scale);
      setBusy(true);
      setError(undefined);
      await api("/invoices", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          customerId,
          jobId: jobId || undefined,
          reference: reference.trim(),
          assetCode: asset,
          totalAtomic,
          assetScale: scale,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Issue invoice</strong>
          <small>Record an exact customer obligation.</small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <Loadable state={customers}>
          {({ items: customerItems }) => (
            <Loadable state={jobs}>
              {({ items: jobItems }) => (
                <div className="create-fields">
                  <label>
                    <span>Customer</span>
                    <select
                      value={customerId}
                      onChange={(event) => {
                        setCustomerId(event.target.value);
                        setJobId("");
                      }}
                    >
                      <option value="">Select customer</option>
                      {customerItems.map((customer) => (
                        <option value={customer.id} key={customer.id}>
                          {customer.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Job (optional)</span>
                    <select
                      value={jobId}
                      onChange={(event) => setJobId(event.target.value)}
                    >
                      <option value="">No linked job</option>
                      {jobItems
                        .filter((job) => job.customer_id === customerId)
                        .map((job) => (
                          <option value={job.id} key={job.id}>
                            {job.reference} · {humanize(job.status)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <span>Invoice reference</span>
                    <input
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      placeholder="INV-00293"
                    />
                  </label>
                  <label>
                    <span>Currency</span>
                    <select
                      value={asset}
                      onChange={(event) =>
                        setAsset(event.target.value as "USD" | "USDC")
                      }
                    >
                      <option value="USD">USD</option>
                      <option value="USDC">USDC</option>
                    </select>
                  </label>
                  <label>
                    <span>Total</span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="1000.00"
                    />
                  </label>
                  {error ? <p className="inline-error">{error}</p> : null}
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void submit()}
                  >
                    {busy ? "Issuing…" : "Issue invoice"}
                  </button>
                </div>
              )}
            </Loadable>
          )}
        </Loadable>
      ) : null}
    </section>
  );
}

type InvoiceOption = Readonly<{
  id: string;
  reference: string;
  status: string;
  asset_code: string;
  total_atomic: string;
  asset_scale: number;
}>;

function CreatePaymentPanel() {
  const invoices = useApi<{ items: readonly InvoiceOption[] }>("/invoices");
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (items: readonly InvoiceOption[]) => {
    try {
      const invoice = items.find((item) => item.id === invoiceId);
      if (!invoice || !reference.trim()) {
        throw new TypeError(
          "Issued invoice and payment reference are required.",
        );
      }
      const amountAtomic = decimalToAtomic(amount, invoice.asset_scale);
      setBusy(true);
      setError(undefined);
      await api("/payments", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          invoiceId,
          externalReference: reference.trim(),
          amountAtomic,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Record payment</strong>
          <small>
            Create a pending receipt before controlled confirmation.
          </small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <Loadable state={invoices}>
          {({ items }) => {
            const issued = items.filter((item) => item.status === "ISSUED");
            return issued.length ? (
              <div className="create-fields">
                <label>
                  <span>Invoice</span>
                  <select
                    value={invoiceId}
                    onChange={(event) => setInvoiceId(event.target.value)}
                  >
                    <option value="">Select invoice</option>
                    {issued.map((invoice) => (
                      <option value={invoice.id} key={invoice.id}>
                        {invoice.reference} ·{" "}
                        {formatMoney(
                          invoice.total_atomic,
                          invoice.asset_scale,
                          invoice.asset_code,
                        )}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Payment reference</span>
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="BANK-OR-WALLET-REFERENCE"
                  />
                </label>
                <label>
                  <span>Amount</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="1000.00"
                  />
                </label>
                {error ? <p className="inline-error">{error}</p> : null}
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void submit(issued)}
                >
                  {busy ? "Recording…" : "Record pending payment"}
                </button>
              </div>
            ) : (
              <Empty message="Issue an invoice before recording a payment." />
            );
          }}
        </Loadable>
      ) : null}
    </section>
  );
}

type PaymentOption = Readonly<{
  id: string;
  external_reference: string;
  status: string;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
}>;

type EscrowMilestoneDraft = Readonly<{
  key: string;
  name: string;
  amount: string;
}>;

function CreateEscrowPanel() {
  const payments = useApi<{ items: readonly PaymentOption[] }>("/payments");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [milestones, setMilestones] = useState<readonly EscrowMilestoneDraft[]>(
    [{ key: crypto.randomUUID(), name: "", amount: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const updateMilestone = (
    key: string,
    field: "name" | "amount",
    value: string,
  ) =>
    setMilestones((current) =>
      current.map((item) =>
        item.key === key ? { ...item, [field]: value } : item,
      ),
    );
  const submit = async (items: readonly PaymentOption[]) => {
    try {
      const payment = items.find((item) => item.id === paymentId);
      if (!payment || !name.trim()) {
        throw new TypeError("Name and funding payment are required.");
      }
      const parsed = milestones.map((milestone) => ({
        name: milestone.name.trim(),
        verificationEventType: "MILESTONE_VERIFIED",
        releaseAmountAtomic: decimalToAtomic(
          milestone.amount,
          payment.asset_scale,
        ),
      }));
      if (parsed.some((milestone) => !milestone.name)) {
        throw new TypeError("Every milestone needs a name.");
      }
      setBusy(true);
      setError(undefined);
      await api("/escrow", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          name: name.trim(),
          fundingPaymentId: paymentId,
          milestones: parsed,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Create escrow arrangement</strong>
          <small>
            Allocate an exact funding receipt across ordered milestones.
          </small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add arrangement"}
        </button>
      </div>
      {open ? (
        <Loadable state={payments}>
          {({ items }) => {
            const eligible = items.filter(
              (item) =>
                item.status === "PENDING" || item.status === "CONFIRMED",
            );
            return eligible.length ? (
              <div className="create-fields">
                <label>
                  <span>Arrangement name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Contractor milestone release"
                  />
                </label>
                <label>
                  <span>Funding payment</span>
                  <select
                    value={paymentId}
                    onChange={(event) => setPaymentId(event.target.value)}
                  >
                    <option value="">Select payment</option>
                    {eligible.map((payment) => (
                      <option value={payment.id} key={payment.id}>
                        {payment.external_reference} ·{" "}
                        {formatMoney(
                          payment.amount_atomic,
                          payment.asset_scale,
                          payment.asset_code,
                        )}{" "}
                        · {humanize(payment.status)}
                      </option>
                    ))}
                  </select>
                </label>
                {milestones.map((milestone, index) => (
                  <div className="split-row" key={milestone.key}>
                    <label>
                      <span>Milestone {index + 1}</span>
                      <input
                        value={milestone.name}
                        onChange={(event) =>
                          updateMilestone(
                            milestone.key,
                            "name",
                            event.target.value,
                          )
                        }
                        placeholder="Verified delivery"
                      />
                    </label>
                    <label>
                      <span>Release amount</span>
                      <input
                        inputMode="decimal"
                        value={milestone.amount}
                        onChange={(event) =>
                          updateMilestone(
                            milestone.key,
                            "amount",
                            event.target.value,
                          )
                        }
                        placeholder="600.00"
                      />
                    </label>
                    {milestones.length > 1 ? (
                      <button
                        className="button secondary"
                        onClick={() =>
                          setMilestones((current) =>
                            current.filter(
                              (item) => item.key !== milestone.key,
                            ),
                          )
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  className="button secondary"
                  onClick={() =>
                    setMilestones((current) => [
                      ...current,
                      { key: crypto.randomUUID(), name: "", amount: "" },
                    ])
                  }
                >
                  Add milestone
                </button>
                {error ? <p className="inline-error">{error}</p> : null}
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void submit(eligible)}
                >
                  {busy ? "Creating…" : "Create draft"}
                </button>
              </div>
            ) : (
              <Empty message="Record a payment before creating escrow." />
            );
          }}
        </Loadable>
      ) : null}
    </section>
  );
}

function EscrowTransitionControl({
  escrowId,
  state,
}: {
  escrowId: string;
  state: string;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const action =
    state === "DRAFT"
      ? "ACTIVATE"
      : state === "AWAITING_FUNDING"
        ? "CONFIRM_FUNDING"
        : undefined;
  const submit = async (requestedAction: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/escrow/${encodeURIComponent(escrowId)}/transitions`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          action: requestedAction,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
      setBusy(false);
    }
  };
  if (!action && state !== "FUNDED" && state !== "PARTIALLY_RELEASED") {
    return null;
  }
  return (
    <div className="record-action vertical-action">
      {(state === "FUNDED" || state === "PARTIALLY_RELEASED") && (
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason required to open dispute"
        />
      )}
      {error ? <small className="inline-error">{error}</small> : null}
      {action ? (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void submit(action)}
        >
          {busy
            ? "Recording…"
            : action === "ACTIVATE"
              ? "Activate funding control"
              : "Confirm funded"}
        </button>
      ) : (
        <button
          className="button secondary"
          disabled={busy || !reason.trim()}
          onClick={() => void submit("OPEN_DISPUTE")}
        >
          {busy ? "Recording…" : "Open dispute"}
        </button>
      )}
    </div>
  );
}

function VerifyMilestoneControl({
  escrowId,
  milestoneId,
}: {
  escrowId: string;
  milestoneId: string;
}) {
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!reference.trim()) {
      setError("An evidence reference is required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `/escrow/${encodeURIComponent(escrowId)}/milestones/${encodeURIComponent(milestoneId)}/verifications`,
        {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            evidence: { accepted: true, reference: reference.trim() },
          }),
        },
      );
      location.reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Verification failed.",
      );
      setBusy(false);
    }
  };
  return (
    <div className="record-action vertical-action">
      <input
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        placeholder="Completion evidence reference"
        aria-label="Milestone evidence reference"
      />
      {error ? <small className="inline-error">{error}</small> : null}
      <button
        className="button primary"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? "Verifying…" : "Verify milestone"}
      </button>
    </div>
  );
}

function CreateApprovalPolicyPanel() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [asset, setAsset] = useState<"USD" | "USDC">("USD");
  const [mode, setMode] = useState<
    "AUTOMATIC" | "MANUAL" | "APPROVAL_REQUIRED"
  >("APPROVAL_REQUIRED");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!name.trim()) {
      setError("A policy name is required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api("/approval-policies", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          name: name.trim(),
          assetCode: asset,
          assetScale: asset === "USDC" ? 6 : 2,
          bands: [
            {
              minAtomicAmount: "0",
              maxAtomicAmount: null,
              mode,
              requirements:
                mode === "APPROVAL_REQUIRED"
                  ? [
                      {
                        role: "FINANCE",
                        count: 1,
                        allowSelfApproval: false,
                      },
                    ]
                  : [],
            },
          ],
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Add approval policy</strong>
          <small>Publish immutable controls for settlement execution.</small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <div className="create-fields">
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>Settlement asset</span>
            <select
              value={asset}
              onChange={(event) =>
                setAsset(event.target.value as "USD" | "USDC")
              }
            >
              <option value="USD">USD</option>
              <option value="USDC">USDC</option>
            </select>
          </label>
          <label>
            <span>Execution control</span>
            <select
              value={mode}
              onChange={(event) =>
                setMode(
                  event.target.value as
                    | "AUTOMATIC"
                    | "MANUAL"
                    | "APPROVAL_REQUIRED",
                )
              }
            >
              <option value="APPROVAL_REQUIRED">Finance approval</option>
              <option value="MANUAL">Manual release</option>
              <option value="AUTOMATIC">Automatic</option>
            </select>
          </label>
          {error ? <p className="inline-error">{error}</p> : null}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Save draft policy"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type PolicyOption = Readonly<{
  id: string;
  name: string;
  status: string;
  version_id: string;
  asset_code: string;
  asset_scale: number;
}>;

type ParticipantOption = Readonly<{
  id: string;
  display_name: string;
  status: string;
}>;

type RuleBeneficiaryDraft = Readonly<{
  key: string;
  participantId: string;
  kind: "PERCENTAGE" | "REMAINDER";
  percentage: string;
}>;

function CreateSettlementRulePanel() {
  const policies = useApi<{ items: readonly PolicyOption[] }>(
    "/approval-policies",
  );
  const participants = useApi<{ items: readonly ParticipantOption[] }>(
    "/participants",
  );
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [policyVersionId, setPolicyVersionId] = useState("");
  const [triggerEventType, setTriggerEventType] = useState("PAYMENT_CONFIRMED");
  const [conditionFact, setConditionFact] = useState("job.status");
  const [conditionValue, setConditionValue] = useState("COMPLETED");
  const [providerKey, setProviderKey] = useState("simulation");
  const [network, setNetwork] = useState("simnet");
  const [beneficiaries, setBeneficiaries] = useState<
    readonly RuleBeneficiaryDraft[]
  >([
    {
      key: crypto.randomUUID(),
      participantId: "",
      kind: "PERCENTAGE",
      percentage: "",
    },
    {
      key: crypto.randomUUID(),
      participantId: "",
      kind: "REMAINDER",
      percentage: "",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const updateBeneficiary = (
    key: string,
    change: Partial<RuleBeneficiaryDraft>,
  ) =>
    setBeneficiaries((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  const submit = async () => {
    try {
      if (!name.trim() || !policyVersionId) {
        throw new TypeError(
          "Rule name and active approval policy are required.",
        );
      }
      const participantIds = beneficiaries.map((item) => item.participantId);
      if (
        participantIds.some((id) => !id) ||
        new Set(participantIds).size !== participantIds.length
      ) {
        throw new TypeError(
          "Select a different participant for each beneficiary.",
        );
      }
      if (
        beneficiaries.filter((item) => item.kind === "REMAINDER").length > 1
      ) {
        throw new TypeError("Only one remainder beneficiary is allowed.");
      }
      const instructions = beneficiaries.map((item) =>
        item.kind === "REMAINDER"
          ? { kind: item.kind, beneficiaryId: item.participantId }
          : {
              kind: item.kind,
              beneficiaryId: item.participantId,
              basisPoints: percentageToBasisPoints(item.percentage),
            },
      );
      setBusy(true);
      setError(undefined);
      await api("/settlement-rules", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          name: name.trim(),
          triggerEventType,
          triggerSchemaVersion: 1,
          priority: 100,
          conditions: conditionFact.trim()
            ? [
                {
                  fact: conditionFact.trim(),
                  operator: "EQUALS",
                  value: conditionValue.trim(),
                },
              ]
            : [],
          beneficiaries: instructions,
          providerPolicy: {
            providerKey: providerKey.trim(),
            network: network.trim(),
            method: "INDIVIDUAL_TRANSFERS",
          },
          approvalPolicyVersionId: policyVersionId,
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>Add settlement rule</strong>
          <small>
            Connect a verified event to generic beneficiary entitlements.
          </small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <Loadable state={policies}>
          {({ items: policyItems }) => (
            <Loadable state={participants}>
              {({ items: participantItems }) => {
                const activePolicies = policyItems.filter(
                  (item) => item.status === "ACTIVE",
                );
                const activeParticipants = participantItems.filter(
                  (item) => item.status === "ACTIVE",
                );
                if (!activePolicies.length || !activeParticipants.length) {
                  return (
                    <Empty message="Activate an approval policy and create active participants before adding a rule." />
                  );
                }
                return (
                  <div className="rule-builder">
                    <div className="create-fields">
                      <label>
                        <span>Rule name</span>
                        <input
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                        />
                      </label>
                      <label>
                        <span>Trigger</span>
                        <select
                          value={triggerEventType}
                          onChange={(event) =>
                            setTriggerEventType(event.target.value)
                          }
                        >
                          <option value="PAYMENT_CONFIRMED">
                            Payment confirmed
                          </option>
                          <option value="INVOICE_PAID">Invoice paid</option>
                          <option value="MILESTONE_VERIFIED">
                            Milestone verified
                          </option>
                        </select>
                      </label>
                      <label>
                        <span>Approval policy</span>
                        <select
                          value={policyVersionId}
                          onChange={(event) =>
                            setPolicyVersionId(event.target.value)
                          }
                        >
                          <option value="">Select active policy</option>
                          {activePolicies.map((policy) => (
                            <option value={policy.version_id} key={policy.id}>
                              {policy.name} · {policy.asset_code}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Required fact</span>
                        <input
                          value={conditionFact}
                          onChange={(event) =>
                            setConditionFact(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>Required value</span>
                        <input
                          value={conditionValue}
                          onChange={(event) =>
                            setConditionValue(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>Execution route</span>
                        <input
                          value={providerKey}
                          onChange={(event) =>
                            setProviderKey(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>Environment</span>
                        <input
                          value={network}
                          onChange={(event) => setNetwork(event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="beneficiary-builder">
                      <div>
                        <strong>Beneficiaries</strong>
                        <button
                          className="button secondary"
                          onClick={() =>
                            setBeneficiaries((current) => [
                              ...current,
                              {
                                key: crypto.randomUUID(),
                                participantId: "",
                                kind: "PERCENTAGE",
                                percentage: "",
                              },
                            ])
                          }
                        >
                          Add beneficiary
                        </button>
                      </div>
                      {beneficiaries.map((item, index) => (
                        <div className="beneficiary-row" key={item.key}>
                          <span>{index + 1}</span>
                          <select
                            value={item.participantId}
                            onChange={(event) =>
                              updateBeneficiary(item.key, {
                                participantId: event.target.value,
                              })
                            }
                          >
                            <option value="">Select participant</option>
                            {activeParticipants.map((participant) => (
                              <option
                                value={participant.id}
                                key={participant.id}
                              >
                                {participant.display_name}
                              </option>
                            ))}
                          </select>
                          <select
                            value={item.kind}
                            onChange={(event) =>
                              updateBeneficiary(item.key, {
                                kind: event.target.value as
                                  | "PERCENTAGE"
                                  | "REMAINDER",
                              })
                            }
                          >
                            <option value="PERCENTAGE">Percentage</option>
                            <option value="REMAINDER">Remainder</option>
                          </select>
                          {item.kind === "PERCENTAGE" ? (
                            <input
                              inputMode="decimal"
                              value={item.percentage}
                              onChange={(event) =>
                                updateBeneficiary(item.key, {
                                  percentage: event.target.value,
                                })
                              }
                              placeholder="70"
                              aria-label="Percentage"
                            />
                          ) : (
                            <small>Receives the exact balance</small>
                          )}
                          {beneficiaries.length > 1 ? (
                            <button
                              className="button quiet"
                              onClick={() =>
                                setBeneficiaries((current) =>
                                  current.filter(
                                    (candidate) => candidate.key !== item.key,
                                  ),
                                )
                              }
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {error ? <p className="inline-error">{error}</p> : null}
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => void submit()}
                    >
                      {busy ? "Saving…" : "Save draft rule"}
                    </button>
                  </div>
                );
              }}
            </Loadable>
          )}
        </Loadable>
      ) : null}
    </section>
  );
}

function ConfigurationTransitionButton({
  endpoint,
  configurationId,
  status,
}: {
  endpoint: string;
  configurationId: string;
  status: "DRAFT" | "ACTIVE";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const action = status === "DRAFT" ? "ACTIVATE" : "DEACTIVATE";
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api(
        `${endpoint}/${encodeURIComponent(configurationId)}/transitions`,
        {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({
            action,
            reason:
              action === "DEACTIVATE"
                ? "Deactivated through the configuration workspace."
                : undefined,
          }),
        },
      );
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
      setBusy(false);
    }
  };
  return (
    <div className="record-action">
      {error ? <small className="inline-error">{error}</small> : null}
      <button
        className={`button ${action === "ACTIVATE" ? "primary" : "secondary"}`}
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy
          ? "Recording…"
          : action === "ACTIVATE"
            ? "Activate"
            : "Deactivate"}
      </button>
    </div>
  );
}

function CreatePartyPanel({ kind }: { kind: "CUSTOMER" | "PARTICIPANT" }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [participantType, setParticipantType] = useState("CONTRACTOR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!name.trim()) {
      setError("A name is required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(kind === "CUSTOMER" ? "/customers" : "/participants", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify(
          kind === "CUSTOMER"
            ? {
                displayName: name.trim(),
                email: email.trim() || undefined,
                phone: phone.trim() || undefined,
              }
            : { displayName: name.trim(), participantType },
        ),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Creation failed.");
      setBusy(false);
    }
  };
  return (
    <section className="panel create-panel">
      <div>
        <div>
          <strong>
            Add {kind === "CUSTOMER" ? "customer" : "participant"}
          </strong>
          <small>
            {kind === "CUSTOMER"
              ? "Create a business counterparty."
              : "Create a reusable settlement beneficiary."}
          </small>
        </div>
        <button className="button secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Add record"}
        </button>
      </div>
      {open ? (
        <div className="create-fields">
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {kind === "CUSTOMER" ? (
            <>
              <label>
                <span>Email</span>
                <input
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                <span>Phone</span>
                <input
                  inputMode="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label>
              <span>Type</span>
              <select
                value={participantType}
                onChange={(event) => setParticipantType(event.target.value)}
              >
                <option value="EMPLOYEE">Employee</option>
                <option value="CONTRACTOR">Contractor</option>
                <option value="SUPPLIER">Supplier</option>
                <option value="REFERRER">Referrer</option>
                <option value="INTERNAL_UNIT">Internal unit</option>
              </select>
            </label>
          )}
          {error ? <p className="inline-error">{error}</p> : null}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ConfirmPaymentButton({ paymentId }: { paymentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/payments/${encodeURIComponent(paymentId)}/confirm`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({}),
      });
      location.reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Confirmation failed.",
      );
      setBusy(false);
    }
  };
  return (
    <div className="record-action">
      {error ? <small className="inline-error">{error}</small> : null}
      <button
        className="button primary"
        disabled={busy}
        onClick={() => void confirm()}
      >
        {busy ? "Confirming…" : "Confirm payment"}
      </button>
    </div>
  );
}

function VoidInvoiceControl({ invoiceId }: { invoiceId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!reason.trim()) {
      setError("A reason is required to void an invoice.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(`/invoices/${encodeURIComponent(invoiceId)}/void`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ reason: reason.trim() }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Void failed.");
      setBusy(false);
    }
  };
  return (
    <div className="record-action vertical-action">
      {open ? (
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason for voiding"
          aria-label="Reason for voiding invoice"
        />
      ) : null}
      {error ? <small className="inline-error">{error}</small> : null}
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => (open ? void submit() : setOpen(true))}
      >
        {busy ? "Recording…" : open ? "Confirm void" : "Void invoice"}
      </button>
    </div>
  );
}

function FinancialCorrectionControl({
  endpoint,
  actionLabel,
  evidenceLabel,
}: {
  endpoint: string;
  actionLabel: string;
  evidenceLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!reason.trim() || !evidenceReference.trim()) {
      setError("A reason and evidence reference are required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(endpoint, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          reason: reason.trim(),
          evidenceReference: evidenceReference.trim(),
        }),
      });
      location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Correction failed.");
      setBusy(false);
    }
  };
  return (
    <div className="record-action vertical-action">
      {open ? (
        <>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason"
            aria-label={`${actionLabel} reason`}
          />
          <input
            value={evidenceReference}
            onChange={(event) => setEvidenceReference(event.target.value)}
            placeholder={evidenceLabel}
            aria-label={evidenceLabel}
          />
        </>
      ) : null}
      {error ? <small className="inline-error">{error}</small> : null}
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => (open ? void submit() : setOpen(true))}
      >
        {busy
          ? "Recording…"
          : open
            ? `Confirm ${actionLabel.toLowerCase()}`
            : actionLabel}
      </button>
    </div>
  );
}

type LoadState<T> =
  | { loading: true }
  | { loading: false; data: T }
  | { loading: false; error: Error };
function useApi<T>(path: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ loading: true });
  useEffect(() => {
    let active = true;
    api<T>(path)
      .then((data) => {
        if (active) setState({ loading: false, data });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            loading: false,
            error:
              error instanceof Error
                ? error
                : new Error("Unable to load data."),
          });
      });
    return () => {
      active = false;
    };
  }, [path]);
  return state;
}

function Loadable<T>({
  state,
  children,
}: {
  state: LoadState<T>;
  children: (data: T) => ReactNode;
}) {
  if (state.loading)
    return (
      <div className="loading">
        <span />
        <span />
        <span />
      </div>
    );
  if ("error" in state) return <ErrorState error={state.error} />;
  return children(state.data);
}

function Page({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="page-heading">
        <span className="eyebrow">Workspace</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </>
  );
}
function Metric({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: number;
  attention?: boolean;
}) {
  return (
    <article className={`metric ${attention ? "attention" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
function PanelHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <header className="panel-heading">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span
      className={`status status-${value.toLowerCase().replaceAll("_", "-")}`}
    >
      {humanize(value)}
    </span>
  );
}
function Empty({ message }: { message: string }) {
  return (
    <div className="empty">
      <span>—</span>
      <p>{message}</p>
    </div>
  );
}
function ErrorState({ error }: { error: Error }) {
  const hint =
    error instanceof ApiError && error.code === "ORGANISATION_REQUIRED"
      ? "Enter the organisation ID in the top bar."
      : "Check your access and try again.";
  return (
    <div className="error-state">
      <strong>Unable to load this view</strong>
      <p>{error.message}</p>
      <small>{hint}</small>
    </div>
  );
}
function Definition({
  rows,
}: {
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <dl>
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatMoney(atomic: string, scale: number, asset: string): string {
  const negative = atomic.startsWith("-");
  const digits = negative ? atomic.slice(1) : atomic;
  const padded = digits.padStart(scale + 1, "0");
  const whole = scale === 0 ? padded : padded.slice(0, -scale);
  const fraction = scale === 0 ? "" : padded.slice(-scale).replace(/0+$/, "");
  const value = `${negative ? "-" : ""}${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
  return `${asset} ${value}`;
}
function decimalToAtomic(value: string, scale: number): string {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match?.[1]) {
    throw new TypeError("Enter a positive amount using decimal digits.");
  }
  const fraction = match[2] ?? "";
  if (fraction.length > scale) {
    throw new TypeError(
      `This currency supports at most ${scale} decimal places.`,
    );
  }
  const atomic = BigInt(`${match[1]}${fraction.padEnd(scale, "0")}`).toString();
  if (atomic === "0") throw new TypeError("Amount must be greater than zero.");
  return atomic;
}
function decimalQuantity(value: string): { atomic: string; scale: number } {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match?.[1]) {
    throw new TypeError(
      "Enter a positive quantity with at most six decimal places.",
    );
  }
  const fraction = match[2] ?? "";
  const atomic = BigInt(`${match[1]}${fraction}`).toString();
  if (atomic === "0")
    throw new TypeError("Quantity must be greater than zero.");
  return { atomic, scale: fraction.length };
}
function percentageToBasisPoints(value: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match?.[1]) {
    throw new TypeError(
      "Enter each percentage with at most two decimal places.",
    );
  }
  const basisPoints = Number(
    BigInt(`${match[1]}${(match[2] ?? "").padEnd(2, "0")}`),
  );
  if (basisPoints < 1 || basisPoints > 10_000) {
    throw new TypeError(
      "Each percentage must be greater than 0 and at most 100.",
    );
  }
  return basisPoints;
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
function shortId(value: string): string {
  return value.length <= 18
    ? value
    : `${value.slice(0, 10)}…${value.slice(-5)}`;
}
function humanize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function safePolicyLabel(value: string): string {
  try {
    const parsed = JSON.parse(value) as { mode?: unknown };
    return typeof parsed.mode === "string"
      ? humanize(parsed.mode)
      : "Configured";
  } catch {
    return "Configured";
  }
}

function safePolicyMode(value: string): string {
  try {
    const parsed = JSON.parse(value) as { mode?: unknown };
    return typeof parsed.mode === "string" ? parsed.mode : "";
  } catch {
    return "";
  }
}

function displayValue(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function collectionPrimaryLabel(item: Record<string, unknown>): string {
  for (const key of [
    "reference",
    "display_name",
    "name",
    "action",
    "source_reference",
    "posting_purpose",
    "id",
  ]) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "Record";
}

function collectionSecondaryLabel(item: Record<string, unknown>): string {
  for (const key of ["status", "participant_type", "aggregate_type"]) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "recorded";
}
