-- Idempotent flagship dataset. It configures business and financial records,
-- but deliberately leaves the payment pending so the demo begins with a
-- real, audited confirmation command.

INSERT OR IGNORE INTO organisations (id, name, created_at, updated_at)
VALUES ('org-metro-auto', 'Metro Auto Works', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO participants
  (id, organisation_id, display_name, participant_type, status, created_at, updated_at)
VALUES
  ('participant-workshop', 'org-metro-auto', 'Metro Auto Works', 'ORGANISATION', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('participant-john', 'org-metro-auto', 'John Kamau', 'CONTRACTOR', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('participant-referrer', 'org-metro-auto', 'Amina Referral Partners', 'REFERRER', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO approval_policies
  (id, organisation_id, name, status, created_at, updated_at)
VALUES
  ('approval-policy-standard', 'org-metro-auto', 'Standard settlement control', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO approval_policy_versions
  (id, policy_id, version, policy_json, created_by, created_at)
VALUES (
  'approval-policy-standard-v1',
  'approval-policy-standard',
  1,
  '{"id":"approval-policy-standard-v1","policyId":"approval-policy-standard","version":1,"assetCode":"USD","assetScale":2,"bands":[{"minAtomicAmount":"0","maxAtomicAmount":"50000","mode":"AUTOMATIC","requirements":[]},{"minAtomicAmount":"50001","maxAtomicAmount":"500000","mode":"APPROVAL_REQUIRED","requirements":[{"role":"MANAGER","count":1,"allowSelfApproval":false}]},{"minAtomicAmount":"500001","maxAtomicAmount":null,"mode":"APPROVAL_REQUIRED","requirements":[{"role":"FINANCE","count":2,"allowSelfApproval":false}]}]}',
  'demo-seed',
  '2026-09-14T08:00:00Z'
);

INSERT OR IGNORE INTO settlement_rules
  (id, organisation_id, name, status, created_at, updated_at)
VALUES
  ('rule-workshop-partner-split', 'org-metro-auto', 'Workshop Partner Split', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO settlement_rule_versions
  (id, rule_id, version, trigger_event_type, trigger_schema_version, priority,
   effective_from, conditions_json, beneficiaries_json, provider_policy_json,
   approval_policy_version_id, created_by, created_at)
VALUES (
  'rule-workshop-partner-split-v1',
  'rule-workshop-partner-split',
  1,
  'PAYMENT_CONFIRMED',
  1,
  100,
  '2026-09-01T00:00:00Z',
  '[{"fact":"job.status","operator":"EQUALS","value":"COMPLETED"},{"fact":"payment.amount","operator":"MONEY_AT_LEAST","value":{"assetCode":"USD","atomicAmount":"1","scale":2}}]',
  '[{"kind":"PERCENTAGE","beneficiaryId":"participant-workshop","basisPoints":2500},{"kind":"PERCENTAGE","beneficiaryId":"participant-john","basisPoints":7000},{"kind":"PERCENTAGE","beneficiaryId":"participant-referrer","basisPoints":500}]',
  '{"providerKey":"simulation","network":"simnet","method":"INDIVIDUAL_TRANSFERS"}',
  'approval-policy-standard-v1',
  'demo-seed',
  '2026-09-14T08:00:00Z'
);

INSERT OR IGNORE INTO settlement_provider_sources
  (id, organisation_id, provider, network, source_reference, status, created_at, updated_at)
VALUES
  ('source-metro-treasury', 'org-metro-auto', 'simulation', 'simnet', 'metro-treasury', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO participant_settlement_destinations
  (id, organisation_id, participant_id, provider, network, address, status, created_at, updated_at)
VALUES
  ('destination-workshop', 'org-metro-auto', 'participant-workshop', 'simulation', 'simnet', 'sim:metro-workshop', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('destination-john', 'org-metro-auto', 'participant-john', 'simulation', 'simnet', 'sim:john-kamau', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('destination-referrer', 'org-metro-auto', 'participant-referrer', 'simulation', 'simnet', 'sim:amina-referrals', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO ledger_accounts
  (id, organisation_id, code, name, account_type, asset_code, asset_scale, status, created_at)
VALUES
  ('account-digital-cash', 'org-metro-auto', '1000', 'Settlement Digital Cash', 'ASSET', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z'),
  ('account-operating-cash', 'org-metro-auto', '1010', 'Operating Digital Cash', 'ASSET', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z'),
  ('account-customer-receivable', 'org-metro-auto', '1100', 'Customer Receivable', 'ASSET', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z'),
  ('account-settlement-clearing', 'org-metro-auto', '2100', 'Settlement Clearing', 'LIABILITY', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z'),
  ('account-service-revenue', 'org-metro-auto', '4000', 'Service Revenue', 'REVENUE', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z'),
  ('account-contractor-expense', 'org-metro-auto', '5100', 'Contractor Expense', 'EXPENSE', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z'),
  ('account-referral-expense', 'org-metro-auto', '5110', 'Referral Expense', 'EXPENSE', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO accounting_posting_policies
  (id, organisation_id, name, status, created_at, updated_at)
VALUES
  ('accounting-policy-invoice', 'org-metro-auto', 'Invoice recognition', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('accounting-policy-receipt', 'org-metro-auto', 'Payment receipt', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('accounting-policy-obligation', 'org-metro-auto', 'Settlement obligations', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z'),
  ('accounting-policy-settlement', 'org-metro-auto', 'Settlement cash movement', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO accounting_posting_policy_versions
  (id, policy_id, version, trigger_event_type, priority, effective_from,
   policy_json, created_by, created_at)
VALUES
  ('accounting-policy-invoice-v1', 'accounting-policy-invoice', 1,
   'INVOICE_ISSUED', 100, '2026-09-01T00:00:00Z',
   '{"kind":"INVOICE_ISSUED_V1","assetCode":"USD","scale":2,"receivableDebitAccountId":"account-customer-receivable","revenueCreditAccountId":"account-service-revenue"}',
   'demo-seed', '2026-09-14T08:00:00Z'),
  ('accounting-policy-receipt-v1', 'accounting-policy-receipt', 1,
   'PAYMENT_CONFIRMED', 100, '2026-09-01T00:00:00Z',
   '{"kind":"PAYMENT_RECEIPT_V1","assetCode":"USD","scale":2,"cashDebitAccountId":"account-digital-cash","receivableCreditAccountId":"account-customer-receivable"}',
   'demo-seed', '2026-09-14T08:00:00Z'),
  ('accounting-policy-obligation-v1', 'accounting-policy-obligation', 1,
   'FLOWPAY_SETTLEMENT_CREATED', 100, '2026-09-01T00:00:00Z',
   '{"kind":"SETTLEMENT_OBLIGATION_V1","assetCode":"USD","scale":2,"beneficiaryAccounts":[{"beneficiaryId":"participant-john","debitAccountId":"account-contractor-expense","creditAccountId":"account-settlement-clearing"},{"beneficiaryId":"participant-referrer","debitAccountId":"account-referral-expense","creditAccountId":"account-settlement-clearing"}]}',
   'demo-seed', '2026-09-14T08:00:00Z'),
  ('accounting-policy-settlement-v2', 'accounting-policy-settlement', 2,
   'FLOWPAY_SETTLEMENT_CONFIRMED', 101, '2026-09-01T00:00:00Z',
   '{"kind":"SETTLEMENT_CASH_MOVEMENT_V1","assetCode":"USD","scale":2,"distributionDebitAccountId":"account-settlement-clearing","cashCreditAccountId":"account-digital-cash","beneficiaryDebitAccounts":[{"beneficiaryId":"participant-workshop","accountId":"account-operating-cash"}]}',
   'demo-seed', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO customers
  (id, organisation_id, display_name, email, phone, status, created_at, updated_at)
VALUES
  ('customer-nissan-juke', 'org-metro-auto', 'Grace Wanjiku', 'grace@example.com', '+254700000000', 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO services
  (id, organisation_id, name, description, unit_price_atomic, asset_code,
   asset_scale, status, created_at, updated_at)
VALUES
  ('service-repair', 'org-metro-auto', 'Mechanical repair', 'Parts and labour for completed repair', '100000', 'USD', 2, 'ACTIVE', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO jobs
  (id, organisation_id, customer_id, reference, title, description, status,
   created_at, updated_at, completed_at)
VALUES
  ('job-nissan-juke', 'org-metro-auto', 'customer-nissan-juke', 'JOB-00182',
   'Nissan Juke repair', 'Mechanical repair and paint correction', 'COMPLETED',
   '2026-09-14T08:00:00Z', '2026-09-14T11:00:00Z', '2026-09-14T11:00:00Z');

INSERT OR IGNORE INTO job_participants (job_id, participant_id, role, assigned_at)
VALUES
  ('job-nissan-juke', 'participant-john', 'MECHANIC', '2026-09-14T08:00:00Z'),
  ('job-nissan-juke', 'participant-referrer', 'REFERRER', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO workshop_vehicles
  (id, organisation_id, customer_id, registration, make, model, created_at, updated_at)
VALUES
  ('vehicle-nissan-juke', 'org-metro-auto', 'customer-nissan-juke', 'KDA 123A', 'Nissan', 'Juke', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO workshop_job_details
  (job_id, organisation_id, vehicle_id, odometer, reported_concern, created_at, updated_at)
VALUES
  ('job-nissan-juke', 'org-metro-auto', 'vehicle-nissan-juke', 84210,
   'Engine vibration and damaged paintwork', '2026-09-14T08:00:00Z', '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO quotes
  (id, organisation_id, customer_id, job_id, reference, status, asset_code,
   total_atomic, asset_scale, issued_at, approved_at, created_at, updated_at)
VALUES
  ('quote-nissan-juke', 'org-metro-auto', 'customer-nissan-juke', 'job-nissan-juke',
   'QUO-00176', 'DRAFT', 'USD', '100000', 2, NULL,
   NULL, '2026-09-14T08:30:00Z', '2026-09-14T08:30:00Z');

INSERT OR IGNORE INTO quote_lines
  (id, quote_id, service_id, position, description, quantity_atomic,
   quantity_scale, unit_price_atomic, line_total_atomic)
VALUES
  ('quote-line-nissan-juke', 'quote-nissan-juke', 'service-repair', 0,
   'Mechanical repair and paint correction', '1', 0, '100000', '100000');

INSERT INTO quote_state_transitions
  (id, organisation_id, quote_id, from_status, to_status, action, actor_id,
   correlation_id, command_fingerprint, occurred_at)
SELECT
  'quote-transition-nissan-issued', 'org-metro-auto', 'quote-nissan-juke',
  'DRAFT', 'ISSUED', 'ISSUE', 'demo-seed', 'demo-quote-nissan-juke',
  '1111111111111111111111111111111111111111111111111111111111111111',
  '2026-09-14T08:30:00Z'
WHERE EXISTS (
  SELECT 1 FROM quotes WHERE id = 'quote-nissan-juke' AND status = 'DRAFT'
) AND NOT EXISTS (
  SELECT 1 FROM quote_state_transitions WHERE id = 'quote-transition-nissan-issued'
);

UPDATE quotes
SET status = 'ISSUED', issued_at = '2026-09-14T08:30:00Z',
    updated_at = '2026-09-14T08:30:00Z'
WHERE id = 'quote-nissan-juke' AND status = 'DRAFT';

INSERT INTO quote_state_transitions
  (id, organisation_id, quote_id, from_status, to_status, action, actor_id,
   correlation_id, command_fingerprint, occurred_at)
SELECT
  'quote-transition-nissan-approved', 'org-metro-auto', 'quote-nissan-juke',
  'ISSUED', 'APPROVED', 'APPROVE', 'demo-seed', 'demo-quote-nissan-juke',
  '2222222222222222222222222222222222222222222222222222222222222222',
  '2026-09-14T09:00:00Z'
WHERE EXISTS (
  SELECT 1 FROM quotes WHERE id = 'quote-nissan-juke' AND status = 'ISSUED'
) AND NOT EXISTS (
  SELECT 1 FROM quote_state_transitions WHERE id = 'quote-transition-nissan-approved'
);

UPDATE quotes
SET status = 'APPROVED', approved_at = '2026-09-14T09:00:00Z',
    updated_at = '2026-09-14T09:00:00Z'
WHERE id = 'quote-nissan-juke' AND status = 'ISSUED';

INSERT OR IGNORE INTO invoices
  (id, organisation_id, customer_id, job_id, quote_id, reference, status,
   asset_code, total_atomic, asset_scale, issued_at, due_at, created_at, updated_at)
VALUES
  ('invoice-nissan-juke', 'org-metro-auto', 'customer-nissan-juke', 'job-nissan-juke',
   'quote-nissan-juke', 'INV-00292', 'ISSUED', 'USD', '100000', 2,
   '2026-09-14T11:05:00Z', '2026-09-21T23:59:59Z', '2026-09-14T11:05:00Z',
   '2026-09-14T11:05:00Z');

INSERT OR IGNORE INTO invoice_lines
  (id, invoice_id, service_id, position, description, quantity_atomic,
   quantity_scale, unit_price_atomic, line_total_atomic)
VALUES
  ('invoice-line-nissan-juke', 'invoice-nissan-juke', 'service-repair', 0,
   'Mechanical repair and paint correction', '1', 0, '100000', '100000');

INSERT OR IGNORE INTO payments
  (id, organisation_id, invoice_id, external_reference, status, asset_code,
   amount_atomic, asset_scale, received_at, created_at, updated_at)
VALUES
  ('payment-nissan-juke', 'org-metro-auto', 'invoice-nissan-juke', 'PAY-00292',
   'PENDING', 'USD', '100000', 2, '2026-09-14T11:30:00Z',
   '2026-09-14T11:30:00Z', '2026-09-14T11:30:00Z');

-- A second, industry-neutral example demonstrates the escrow domain without
-- pretending funds have already been received or released.
INSERT OR IGNORE INTO escrow_arrangements
  (id, organisation_id, name, asset_code, amount_atomic, asset_scale, state,
   created_by, created_at, updated_at)
VALUES
  ('escrow-contractor-milestones', 'org-metro-auto', 'Contractor milestone plan',
   'USD', '200000', 2, 'DRAFT', 'demo-seed', '2026-09-14T08:00:00Z',
   '2026-09-14T08:00:00Z');

INSERT OR IGNORE INTO escrow_milestones
  (id, escrow_arrangement_id, position, name, verification_event_type,
   asset_code, release_amount_atomic, asset_scale, created_at)
VALUES
  ('escrow-milestone-1', 'escrow-contractor-milestones', 0,
   'Milestone 1 complete', 'MILESTONE_VERIFIED', 'USD', '60000', 2,
   '2026-09-14T08:00:00Z'),
  ('escrow-milestone-2', 'escrow-contractor-milestones', 1,
   'Milestone 2 complete', 'MILESTONE_VERIFIED', 'USD', '80000', 2,
   '2026-09-14T08:00:00Z'),
  ('escrow-milestone-3', 'escrow-contractor-milestones', 2,
   'Final completion', 'MILESTONE_VERIFIED', 'USD', '60000', 2,
   '2026-09-14T08:00:00Z');
