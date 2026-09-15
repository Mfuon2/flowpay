export type DashboardData = Readonly<{
  customers: number;
  openJobs: number;
  openInvoices: number;
  pendingApprovals: number;
  settlementsByState: readonly Readonly<{ state: string; count: number }>[];
}>;

export type OperationsData = Readonly<{
  generatedAt: string;
  items: readonly Readonly<{
    id: string;
    label: string;
    severity: "INFO" | "CRITICAL";
    path: string;
    count: number;
    oldestAt: string | null;
  }>[];
}>;

export type SettlementListItem = Readonly<{
  id: string;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
  state: string;
  created_at: string;
}>;

export type SettlementDetail = Readonly<{
  settlement: SettlementListItem &
    Readonly<{
      rule_name: string;
      rule_version: number;
      event_type: string;
      evaluation_evidence_json: string;
      correlation_id: string;
    }>;
  distributions: readonly Readonly<{
    id: string;
    beneficiary_name: string;
    calculation_kind: string;
    amount_atomic: string;
    asset_code: string;
    asset_scale: number;
    state: string;
  }>[];
  approvals: readonly Readonly<{
    id: string;
    status: string;
    requirements_json: string;
    decisions_json: string;
  }>[];
  transitions: readonly Readonly<{
    id: string;
    from_state: string;
    to_state: string;
    action: string;
    actor_id: string;
    occurred_at: string;
    reason: string | null;
  }>[];
  audit: readonly Readonly<{
    id: string;
    action: string;
    actor_id: string;
    occurred_at: string;
    evidence_json: string;
  }>[];
  reconciliations: readonly Readonly<{
    id: string;
    status: string;
    evidence_json: string;
  }>[];
  providerTransactions: readonly Readonly<{
    id: string;
    beneficiary_name: string;
    provider: string;
    provider_transaction_id: string | null;
    network: string | null;
    network_transaction_reference: string | null;
    status: string;
  }>[];
  settlementAttempts: readonly Readonly<{
    id: string;
    attempt_number: number;
    status: string;
    error_code: string | null;
    error_message: string | null;
    started_at: string;
    completed_at: string | null;
    distribution_id: string;
    beneficiary_name: string;
  }>[];
  journalEntries: readonly Readonly<{
    id: string;
    posting_purpose: string;
    status: string;
    posted_at: string | null;
    lines_json: string;
  }>[];
}>;

export type EscrowListItem = Readonly<{
  id: string;
  name: string;
  funding_payment_id: string;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
  status: string;
  state_version: number;
  created_at: string;
}>;

export type EscrowDetail = Readonly<{
  escrow: Readonly<{
    id: string;
    name: string;
    funding_payment_id: string;
    funding_reference: string;
    funding_status: string;
    asset_code: string;
    amount_atomic: string;
    asset_scale: number;
    state: string;
    state_version: number;
    created_at: string;
    updated_at: string;
  }>;
  milestones: readonly Readonly<{
    id: string;
    position: number;
    name: string;
    verification_event_type: string;
    asset_code: string;
    release_amount_atomic: string;
    asset_scale: number;
    verification_id: string | null;
    verified_by: string | null;
    evidence_json: string | null;
    verified_at: string | null;
    business_event_id: string | null;
    settlement_id: string | null;
    settlement_state: string | null;
    release_id: string | null;
    released_at: string | null;
  }>[];
  transitions: readonly Readonly<{
    id: string;
    from_state: string;
    to_state: string;
    action: string;
    actor_id: string;
    reason: string | null;
    occurred_at: string;
  }>[];
  audit: readonly Readonly<{
    id: string;
    action: string;
    actor_id: string;
    evidence_json: string;
    occurred_at: string;
  }>[];
}>;
