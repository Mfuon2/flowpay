import {
  AuthenticationError,
  AuthorizationError,
  authenticateAccessIdentity,
  authenticateOrganisationRequest,
  requireAnyRole,
  type AccessIdentity,
  type AuthenticatedPrincipal,
} from "../auth/access-auth.ts";
import { confirmPayment } from "../business/confirm-payment.ts";
import { voidInvoice } from "../business/void-invoice.ts";
import {
  issueInvoice,
  recordPendingPayment,
} from "../business/author-financial-document.ts";
import {
  createCustomer,
  createParticipant,
  type CreateParticipantCommand,
} from "../business/create-party.ts";
import { createJob, transitionJob } from "../business/manage-job.ts";
import {
  createQuote,
  createService,
  transitionQuote,
  type TransitionQuoteCommand,
} from "../business/manage-commercial-catalog.ts";
import { recordApprovalDecision } from "../flowpay/record-approval-decision.ts";
import { recordSettlementRecovery } from "../flowpay/record-settlement-recovery.ts";
import {
  createApprovalPolicy,
  createSettlementRule,
  transitionConfiguration,
} from "../flowpay/author-configuration.ts";
import {
  parseApprovalPolicy,
  parseSettlementRuleRow,
} from "../flowpay/record-parsers.ts";
import {
  MANUAL_SETTLEMENT_PERMISSION,
  recordManualSettlementControl,
} from "../flowpay/record-manual-settlement-control.ts";
import {
  createEscrow,
  transitionEscrowArrangement,
  type TransitionEscrowCommand,
} from "../flowpay/manage-escrow.ts";
import { verifyEscrowMilestone } from "../flowpay/verify-escrow-milestone.ts";
import type { JsonValue } from "@flowpay/domain";
import { reverseJournal } from "../accounting/reverse-journal.ts";
import { resolveReconciliation } from "../accounting/resolve-reconciliation.ts";

export async function handleApiRequest(
  request: Request,
  env: Env,
  authenticate: OrganisationAuthenticator = authenticateOrganisationRequest,
  identify: AccessIdentityAuthenticator = authenticateAccessIdentity,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/auth/identity") {
    try {
      const identity = await identify(request, env);
      return json({
        identity: { email: identity.email, subject: identity.subject },
      });
    } catch (error) {
      return apiError(error);
    }
  }
  if (!url.pathname.startsWith("/api/v1/")) return null;
  try {
    const principal = await authenticate(request, env);
    return await routeAuthenticatedRequest(request, url, env.DB, principal);
  } catch (error) {
    return apiError(error);
  }
}

export type OrganisationAuthenticator = (
  request: Request,
  env: Env,
) => Promise<AuthenticatedPrincipal>;

export type AccessIdentityAuthenticator = (
  request: Request,
  env: Env,
) => Promise<AccessIdentity>;

async function routeAuthenticatedRequest(
  request: Request,
  url: URL,
  database: D1Database,
  principal: AuthenticatedPrincipal,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/v1/me") {
    return json({
      user: {
        id: principal.userId,
        email: principal.email,
        roles: principal.roles,
      },
      organisationId: principal.organisationId,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/dashboard") {
    return dashboard(database, principal.organisationId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/operations") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    return operations(database, principal.organisationId);
  }
  const collections: Readonly<Record<string, CollectionDefinition>> = {
    "/api/v1/customers": {
      table: "customers",
      columns: "id, display_name, email, phone, status, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/participants": {
      table: "participants",
      columns:
        "id, display_name, participant_type, status, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/services": {
      table: "services",
      columns:
        "id, name, description, status, asset_code, unit_price_atomic AS amount_atomic, asset_scale, created_at, updated_at",
      order: "name, id",
    },
    "/api/v1/quotes": {
      table: "quotes",
      columns:
        "id, customer_id, job_id, reference, status, asset_code, total_atomic AS amount_atomic, asset_scale, issued_at, approved_at, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/jobs": {
      table: "jobs",
      columns:
        "id, customer_id, reference, title, description, status, completed_at, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/invoices": {
      table: "invoices",
      columns:
        "id, customer_id, job_id, reference, status, asset_code, total_atomic, asset_scale, issued_at, due_at, paid_at",
      order: "created_at DESC, id",
    },
    "/api/v1/payments": {
      table: "payments",
      columns:
        "id, invoice_id, external_reference, status, asset_code, amount_atomic, asset_scale, received_at, confirmed_at",
      order: "created_at DESC, id",
    },
    "/api/v1/settlements": {
      table: "settlements",
      columns:
        "id, source_event_id, rule_version_id, asset_code, amount_atomic, asset_scale, state, state_version, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/escrow": {
      table: "escrow_arrangements",
      columns:
        "id, name, funding_payment_id, asset_code, amount_atomic, asset_scale, state AS status, state_version, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/settlement-rules": {
      table: "settlement_rules",
      columns:
        "id, name, status, (SELECT id FROM settlement_rule_versions WHERE rule_id = settlement_rules.id ORDER BY version DESC LIMIT 1) AS version_id, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/approval-policies": {
      table: "approval_policies",
      columns:
        "id, name, status, (SELECT id FROM approval_policy_versions WHERE policy_id = approval_policies.id ORDER BY version DESC LIMIT 1) AS version_id, (SELECT json_extract(policy_json, '$.assetCode') FROM approval_policy_versions WHERE policy_id = approval_policies.id ORDER BY version DESC LIMIT 1) AS asset_code, (SELECT json_extract(policy_json, '$.assetScale') FROM approval_policy_versions WHERE policy_id = approval_policies.id ORDER BY version DESC LIMIT 1) AS asset_scale, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/approvals": {
      table: "approval_requests",
      columns:
        "id, settlement_id, policy_version_id, status, requirements_json, created_at, resolved_at",
      order: "created_at DESC, id",
    },
    "/api/v1/settlement-accounts": {
      table: "settlement_provider_sources",
      columns:
        "id, provider, network, source_reference, status, created_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/accounts": {
      table: "ledger_accounts",
      columns:
        "id, code, name, account_type, asset_code, asset_scale, status, created_at",
      order: "code, id",
    },
    "/api/v1/journal-entries": {
      table: "journal_entries",
      columns:
        "id, source_type, source_id, posting_purpose, posting_policy_version, status, effective_at, posted_at, reversal_of_id",
      order: "created_at DESC, id",
    },
    "/api/v1/reconciliations": {
      table: "reconciliation_records",
      columns:
        "id, settlement_distribution_id, provider_transaction_id, journal_entry_id, journal_line_id, status, evidence_json, resolution_json, checked_at, updated_at",
      order: "created_at DESC, id",
    },
    "/api/v1/audit-events": {
      table: "audit_events",
      columns:
        "id, actor_type, actor_id, action, aggregate_type, aggregate_id, correlation_id, causation_id, evidence_json, occurred_at",
      order: "occurred_at DESC, id",
    },
  };
  const collection = collections[url.pathname];
  if (request.method === "GET" && collection) {
    return listCollection(database, principal.organisationId, collection);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/customers") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await createCustomer(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      displayName: requiredString(input.displayName, "Customer name"),
      ...(optionalString(input.email) === undefined
        ? {}
        : { email: optionalString(input.email) }),
      ...(optionalString(input.phone) === undefined
        ? {}
        : { phone: optionalString(input.phone) }),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/participants") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const participantType = requiredString(
      input.participantType,
      "Participant type",
    ) as CreateParticipantCommand["participantType"];
    const result = await createParticipant(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      displayName: requiredString(input.displayName, "Participant name"),
      participantType,
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/jobs") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await createJob(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      customerId: requiredString(input.customerId, "Customer"),
      reference: requiredString(input.reference, "Job reference"),
      title: requiredString(input.title, "Job title"),
      ...(optionalString(input.description) === undefined
        ? {}
        : { description: optionalString(input.description) }),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/services") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await createService(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      name: requiredString(input.name, "Service name"),
      ...(optionalString(input.description) === undefined
        ? {}
        : { description: optionalString(input.description) }),
      assetCode: requiredString(input.assetCode, "Asset code"),
      unitPriceAtomic: requiredString(input.unitPriceAtomic, "Unit price"),
      assetScale: requiredInteger(input.assetScale, "Asset scale"),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/quotes") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const lines = requiredObjectArray(input.lines, "Quote lines").map(
      (line) => ({
        ...(optionalString(line.serviceId) === undefined
          ? {}
          : { serviceId: optionalString(line.serviceId) }),
        description: requiredString(line.description, "Line description"),
        quantityAtomic: requiredString(line.quantityAtomic, "Line quantity"),
        quantityScale: requiredInteger(line.quantityScale, "Quantity scale"),
        unitPriceAtomic: requiredString(line.unitPriceAtomic, "Unit price"),
      }),
    );
    const result = await createQuote(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      customerId: requiredString(input.customerId, "Customer"),
      ...(optionalString(input.jobId) === undefined
        ? {}
        : { jobId: optionalString(input.jobId) }),
      reference: requiredString(input.reference, "Quote reference"),
      assetCode: requiredString(input.assetCode, "Asset code"),
      assetScale: requiredInteger(input.assetScale, "Asset scale"),
      lines,
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/invoices") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await issueInvoice(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      customerId: requiredString(input.customerId, "Customer"),
      ...(optionalString(input.jobId) === undefined
        ? {}
        : { jobId: optionalString(input.jobId) }),
      reference: requiredString(input.reference, "Invoice reference"),
      assetCode: requiredString(input.assetCode, "Asset code"),
      totalAtomic: requiredString(input.totalAtomic, "Invoice total"),
      assetScale: requiredInteger(input.assetScale, "Asset scale"),
      issuedAt: optionalString(input.issuedAt) ?? new Date().toISOString(),
      ...(optionalString(input.dueAt) === undefined
        ? {}
        : { dueAt: optionalString(input.dueAt) }),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/payments") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await recordPendingPayment(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      invoiceId: requiredString(input.invoiceId, "Invoice"),
      externalReference: requiredString(
        input.externalReference,
        "Payment reference",
      ),
      amountAtomic: requiredString(input.amountAtomic, "Payment amount"),
      receivedAt: optionalString(input.receivedAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/escrow") {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const milestones = requiredObjectArray(input.milestones, "Milestones").map(
      (milestone) => ({
        name: requiredString(milestone.name, "Milestone name"),
        verificationEventType: requiredString(
          milestone.verificationEventType,
          "Milestone verification event",
        ),
        releaseAmountAtomic: requiredString(
          milestone.releaseAmountAtomic,
          "Milestone release amount",
        ),
      }),
    );
    const result = await createEscrow(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      name: requiredString(input.name, "Escrow name"),
      fundingPaymentId: requiredString(
        input.fundingPaymentId,
        "Funding payment",
      ),
      milestones,
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/approval-policies"
  ) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const parsed = parseApprovalPolicy(
      stringifyJson(
        {
          id: "request-version",
          policyId: "request-policy",
          version: 1,
          assetCode: input.assetCode,
          assetScale: input.assetScale,
          bands: input.bands,
        },
        "Approval policy",
      ),
    );
    const result = await createApprovalPolicy(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      name: requiredString(input.name, "Policy name"),
      assetCode: parsed.assetCode,
      assetScale: parsed.assetScale,
      bands: parsed.bands,
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/settlement-rules"
  ) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const effectiveFrom =
      optionalString(input.effectiveFrom) ?? new Date().toISOString();
    const parsed = parseSettlementRuleRow({
      id: "request-version",
      rule_id: "request-rule",
      version: 1,
      trigger_event_type: requiredString(
        input.triggerEventType,
        "Trigger event type",
      ),
      trigger_schema_version: requiredInteger(
        input.triggerSchemaVersion,
        "Trigger schema version",
      ),
      priority: requiredInteger(input.priority, "Priority"),
      effective_from: effectiveFrom,
      effective_to: optionalString(input.effectiveTo) ?? null,
      conditions_json: stringifyJson(input.conditions, "Rule conditions"),
      beneficiaries_json: stringifyJson(
        input.beneficiaries,
        "Rule beneficiaries",
      ),
      provider_policy_json: stringifyJson(
        input.providerPolicy,
        "Provider policy",
      ),
      approval_policy_version_id: requiredString(
        input.approvalPolicyVersionId,
        "Approval policy version",
      ),
    });
    const result = await createSettlementRule(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      name: requiredString(input.name, "Rule name"),
      triggerEventType: parsed.triggerEventType,
      triggerSchemaVersion: parsed.triggerSchemaVersion,
      priority: parsed.priority,
      effectiveFrom: parsed.effectiveFrom,
      ...(parsed.effectiveTo === undefined
        ? {}
        : { effectiveTo: parsed.effectiveTo }),
      conditions: parsed.conditions,
      beneficiaries: parsed.beneficiaries,
      providerPolicy: parsed.providerPolicy,
      approvalPolicyVersionId: parsed.approvalPolicyVersionId ?? "",
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }

  const configurationTransition = url.pathname.match(
    /^\/api\/v1\/(approval-policies|settlement-rules)\/([^/]+)\/transitions$/,
  );
  const quoteTransition = url.pathname.match(
    /^\/api\/v1\/quotes\/([^/]+)\/transitions$/,
  );
  if (request.method === "POST" && quoteTransition?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const action = input.action as TransitionQuoteCommand["action"];
    if (!["ISSUE", "APPROVE", "REJECT", "EXPIRE"].includes(action)) {
      throw new TypeError(
        "Quote action must be ISSUE, APPROVE, REJECT, or EXPIRE.",
      );
    }
    const requestId = requireRequestId(request);
    const result = await transitionQuote(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      quoteId: decodeURIComponent(quoteTransition[1]),
      action,
      ...(optionalString(input.reason) === undefined
        ? {}
        : { reason: optionalString(input.reason) }),
      occurredAt: optionalString(input.occurredAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  if (
    request.method === "POST" &&
    configurationTransition?.[1] &&
    configurationTransition[2]
  ) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const action = input.action;
    if (action !== "ACTIVATE" && action !== "DEACTIVATE") {
      throw new TypeError(
        "Configuration action must be ACTIVATE or DEACTIVATE.",
      );
    }
    const requestId = requireRequestId(request);
    const result = await transitionConfiguration(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      configurationType:
        configurationTransition[1] === "approval-policies"
          ? "APPROVAL_POLICY"
          : "SETTLEMENT_RULE",
      configurationId: decodeURIComponent(configurationTransition[2]),
      action,
      ...(optionalString(input.reason) === undefined
        ? {}
        : { reason: optionalString(input.reason) }),
      occurredAt: optionalString(input.occurredAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }

  const jobTransition = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/transitions$/,
  );
  if (request.method === "POST" && jobTransition?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "OPERATIONS"]);
    const input = await jsonObject(request);
    const action = input.action;
    if (action !== "START" && action !== "COMPLETE" && action !== "CANCEL") {
      throw new TypeError("Job action must be START, COMPLETE, or CANCEL.");
    }
    const requestId = requireRequestId(request);
    const result = await transitionJob(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      jobId: decodeURIComponent(jobTransition[1]),
      action,
      ...(optionalString(input.reason) === undefined
        ? {}
        : { reason: optionalString(input.reason) }),
      occurredAt: optionalString(input.occurredAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }

  const settlementDetail = url.pathname.match(
    /^\/api\/v1\/settlements\/([^/]+)$/,
  );
  if (request.method === "GET" && settlementDetail?.[1]) {
    return settlementDetails(
      database,
      principal.organisationId,
      decodeURIComponent(settlementDetail[1]),
    );
  }
  const escrowDetail = url.pathname.match(/^\/api\/v1\/escrow\/([^/]+)$/);
  if (request.method === "GET" && escrowDetail?.[1]) {
    return escrowDetails(
      database,
      principal.organisationId,
      decodeURIComponent(escrowDetail[1]),
    );
  }
  const escrowTransition = url.pathname.match(
    /^\/api\/v1\/escrow\/([^/]+)\/transitions$/,
  );
  if (request.method === "POST" && escrowTransition?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const action = input.action;
    if (!isEscrowAction(action)) {
      throw new TypeError("Escrow action is not supported.");
    }
    const requestId = requireRequestId(request);
    const result = await transitionEscrowArrangement(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      escrowId: decodeURIComponent(escrowTransition[1]),
      action,
      ...(optionalString(input.reason) === undefined
        ? {}
        : { reason: optionalString(input.reason) }),
      occurredAt: optionalString(input.occurredAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const milestoneVerification = url.pathname.match(
    /^\/api\/v1\/escrow\/([^/]+)\/milestones\/([^/]+)\/verifications$/,
  );
  if (
    request.method === "POST" &&
    milestoneVerification?.[1] &&
    milestoneVerification[2]
  ) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "OPERATIONS", "MANAGER"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await verifyEscrowMilestone(database, {
      verificationId: requestId,
      organisationId: principal.organisationId,
      escrowId: decodeURIComponent(milestoneVerification[1]),
      milestoneId: decodeURIComponent(milestoneVerification[2]),
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      evidence: requiredJsonValue(input.evidence, "Verification evidence"),
      verifiedAt: optionalString(input.verifiedAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const paymentConfirmation = url.pathname.match(
    /^\/api\/v1\/payments\/([^/]+)\/confirm$/,
  );
  if (request.method === "POST" && paymentConfirmation?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const confirmedAt =
      optionalString(input.confirmedAt) ?? new Date().toISOString();
    const result = await confirmPayment(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      paymentId: decodeURIComponent(paymentConfirmation[1]),
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      confirmedAt,
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const invoiceVoid = url.pathname.match(
    /^\/api\/v1\/invoices\/([^/]+)\/void$/,
  );
  if (request.method === "POST" && invoiceVoid?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "OPERATIONS"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await voidInvoice(database, {
      commandId: requestId,
      organisationId: principal.organisationId,
      invoiceId: decodeURIComponent(invoiceVoid[1]),
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      reason: requiredString(input.reason, "Void reason"),
      occurredAt: optionalString(input.occurredAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const approvalDecision = url.pathname.match(
    /^\/api\/v1\/settlements\/([^/]+)\/approval-decisions$/,
  );
  if (request.method === "POST" && approvalDecision?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE", "MANAGER"]);
    const input = await jsonObject(request);
    const decision = input.decision;
    if (decision !== "APPROVE" && decision !== "REJECT") {
      throw new TypeError("Decision must be APPROVE or REJECT.");
    }
    const result = await recordApprovalDecision(database, {
      decisionId: requireRequestId(request),
      organisationId: principal.organisationId,
      settlementId: decodeURIComponent(approvalDecision[1]),
      actorId: principal.userId,
      actorRoles: principal.roles,
      decision,
      ...(optionalString(input.reason) === undefined
        ? {}
        : { reason: optionalString(input.reason) }),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const manualControl = url.pathname.match(
    /^\/api\/v1\/settlements\/([^/]+)\/manual-control$/,
  );
  if (request.method === "POST" && manualControl?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const action = input.action;
    if (action !== "RELEASE" && action !== "CANCEL") {
      throw new TypeError("Manual action must be RELEASE or CANCEL.");
    }
    const result = await recordManualSettlementControl(database, {
      commandId: requireRequestId(request),
      organisationId: principal.organisationId,
      settlementId: decodeURIComponent(manualControl[1]),
      actorId: principal.userId,
      actorPermissions: [MANUAL_SETTLEMENT_PERMISSION],
      action,
      ...(optionalString(input.reason) === undefined
        ? {}
        : { reason: optionalString(input.reason) }),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const recoveryDecision = url.pathname.match(
    /^\/api\/v1\/settlements\/([^/]+)\/recovery-decisions$/,
  );
  if (request.method === "POST" && recoveryDecision?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const action = input.action;
    if (action !== "RETRY_CONFIRMED_NOT_SUBMITTED") {
      throw new TypeError(
        "Recovery action must be RETRY_CONFIRMED_NOT_SUBMITTED.",
      );
    }
    const decisionId = requireRequestId(request);
    const result = await recordSettlementRecovery(database, {
      decisionId,
      organisationId: principal.organisationId,
      settlementId: decodeURIComponent(recoveryDecision[1]),
      attemptId: requiredString(input.attemptId, "Settlement attempt"),
      actorId: principal.userId,
      action,
      reason: requiredString(input.reason, "Recovery reason"),
      evidenceReference: requiredString(
        input.evidenceReference,
        "Provider verification reference",
      ),
      decidedAt: optionalString(input.decidedAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const journalReversal = url.pathname.match(
    /^\/api\/v1\/journal-entries\/([^/]+)\/reversals$/,
  );
  if (request.method === "POST" && journalReversal?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await reverseJournal(database, {
      reversalId: requestId,
      organisationId: principal.organisationId,
      journalEntryId: decodeURIComponent(journalReversal[1]),
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      reason: requiredString(input.reason, "Reversal reason"),
      evidenceReference: requiredString(
        input.evidenceReference,
        "Reversal evidence reference",
      ),
      effectiveAt:
        optionalString(input.effectiveAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  const reconciliationResolution = url.pathname.match(
    /^\/api\/v1\/reconciliations\/([^/]+)\/resolutions$/,
  );
  if (request.method === "POST" && reconciliationResolution?.[1]) {
    requireAnyRole(principal, ["OWNER", "ADMIN", "FINANCE"]);
    const input = await jsonObject(request);
    const requestId = requireRequestId(request);
    const result = await resolveReconciliation(database, {
      resolutionId: requestId,
      organisationId: principal.organisationId,
      reconciliationId: decodeURIComponent(reconciliationResolution[1]),
      actorId: principal.userId,
      correlationId: optionalString(input.correlationId) ?? requestId,
      reason: requiredString(input.reason, "Resolution reason"),
      evidenceReference: requiredString(
        input.evidenceReference,
        "Resolution evidence reference",
      ),
      resolvedAt: optionalString(input.resolvedAt) ?? new Date().toISOString(),
    });
    return json(result, { status: result.replayed ? 200 : 201 });
  }
  return json(
    { error: { code: "NOT_FOUND", message: "Not found." } },
    { status: 404 },
  );
}

type CollectionDefinition = Readonly<{
  table: string;
  columns: string;
  order: string;
}>;

async function listCollection(
  database: D1Database,
  organisationId: string,
  definition: CollectionDefinition,
): Promise<Response> {
  const rows = await database
    .prepare(
      `SELECT ${definition.columns} FROM ${definition.table}
       WHERE organisation_id = ? ORDER BY ${definition.order} LIMIT 100`,
    )
    .bind(organisationId)
    .all<Record<string, unknown>>();
  return json({ items: rows.results });
}

async function dashboard(
  database: D1Database,
  organisationId: string,
): Promise<Response> {
  const results = await database.batch<unknown>([
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM customers WHERE organisation_id = ? AND status = 'ACTIVE'",
      )
      .bind(organisationId),
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE organisation_id = ? AND status IN ('DRAFT', 'IN_PROGRESS')",
      )
      .bind(organisationId),
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM invoices WHERE organisation_id = ? AND status = 'ISSUED'",
      )
      .bind(organisationId),
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM approval_requests WHERE organisation_id = ? AND status = 'PENDING'",
      )
      .bind(organisationId),
    database
      .prepare(
        "SELECT state, COUNT(*) AS count FROM settlements WHERE organisation_id = ? GROUP BY state",
      )
      .bind(organisationId),
  ]);
  const customers = results[0]!;
  const openJobs = results[1]!;
  const openInvoices = results[2]!;
  const pendingApprovals = results[3]!;
  const settlements = results[4]!;
  return json({
    customers: firstCount(customers),
    openJobs: firstCount(openJobs),
    openInvoices: firstCount(openInvoices),
    pendingApprovals: firstCount(pendingApprovals),
    settlementsByState: settlements.results,
  });
}

async function operations(
  database: D1Database,
  organisationId: string,
): Promise<Response> {
  const results = await database.batch<unknown>([
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
         FROM outbox_messages
         WHERE organisation_id = ? AND dispatched_at IS NULL`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
         FROM approval_requests
         WHERE organisation_id = ? AND status = 'PENDING'`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(sa.started_at) AS oldest_at
         FROM settlement_attempts sa
         JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
         JOIN settlements s ON s.id = sd.settlement_id
         WHERE s.organisation_id = ? AND sa.status = 'OUTCOME_UNKNOWN'`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(spt.created_at) AS oldest_at
         FROM settlement_provider_transactions spt
         JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
         JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
         JOIN settlements s ON s.id = sd.settlement_id
         WHERE s.organisation_id = ? AND spt.status = 'PENDING'`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
         FROM accounting_work_items
         WHERE organisation_id = ? AND status = 'FAILED'`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(rr.created_at) AS oldest_at
         FROM reconciliation_records rr
         JOIN settlement_distributions sd ON sd.id = rr.settlement_distribution_id
         JOIN settlements s ON s.id = sd.settlement_id
         WHERE s.organisation_id = ? AND rr.status = 'MISMATCHED'`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(recorded_at) AS oldest_at
         FROM queue_message_failures
         WHERE organisation_id = ?`,
      )
      .bind(organisationId),
    database
      .prepare(
        `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_at
         FROM settlement_work_items
         WHERE organisation_id = ? AND status = 'FAILED'`,
      )
      .bind(organisationId),
  ]);
  const definitions = [
    ["outbox", "Events awaiting dispatch", "INFO", "/audit-events"],
    ["approvals", "Approvals awaiting decision", "INFO", "/approvals"],
    ["unknown", "Transfers with unknown outcome", "CRITICAL", "/settlements"],
    ["provider", "Transfers awaiting confirmation", "INFO", "/settlements"],
    ["accounting", "Failed accounting work", "CRITICAL", "/journal-entries"],
    [
      "reconciliation",
      "Reconciliation mismatches",
      "CRITICAL",
      "/reconciliations",
    ],
    ["queue", "Quarantined queue messages", "CRITICAL", "/audit-events"],
    ["settlement", "Failed settlement work", "CRITICAL", "/settlements"],
  ] as const;
  return json({
    generatedAt: new Date().toISOString(),
    items: definitions.map(([id, label, severity, path], index) => ({
      id,
      label,
      severity,
      path,
      ...operationalCount(results[index]!),
    })),
  });
}

function operationalCount(result: D1Result<unknown>): {
  count: number;
  oldestAt: string | null;
} {
  const row = result.results[0] as
    | { count?: unknown; oldest_at?: unknown }
    | undefined;
  return {
    count: typeof row?.count === "number" ? row.count : 0,
    oldestAt: typeof row?.oldest_at === "string" ? row.oldest_at : null,
  };
}

async function settlementDetails(
  database: D1Database,
  organisationId: string,
  settlementId: string,
): Promise<Response> {
  const settlement = await database
    .prepare(
      `SELECT s.*, sr.name AS rule_name, srv.version AS rule_version,
              be.event_type, be.aggregate_type, be.aggregate_id,
              be.correlation_id
       FROM settlements s
       JOIN settlement_rule_versions srv ON srv.id = s.rule_version_id
       JOIN settlement_rules sr ON sr.id = srv.rule_id
       JOIN business_events be ON be.id = s.source_event_id
       WHERE s.id = ? AND s.organisation_id = ?`,
    )
    .bind(settlementId, organisationId)
    .first<Record<string, unknown>>();
  if (!settlement) {
    return json(
      { error: { code: "NOT_FOUND", message: "Settlement not found." } },
      { status: 404 },
    );
  }
  const correlationId = settlement.correlation_id;
  if (typeof correlationId !== "string") {
    throw new Error("Settlement correlation evidence is invalid.");
  }
  const results = await database.batch<unknown>([
    database
      .prepare(
        `SELECT sd.*, p.display_name AS beneficiary_name FROM settlement_distributions sd JOIN participants p ON p.id = sd.beneficiary_id WHERE sd.settlement_id = ? ORDER BY sd.position`,
      )
      .bind(settlementId),
    database
      .prepare(
        `SELECT ar.*, (SELECT json_group_array(json_object('actorId', ad.actor_id, 'decision', ad.decision, 'role', ad.actor_role, 'reason', ad.reason, 'decidedAt', ad.decided_at)) FROM approval_decisions ad WHERE ad.approval_request_id = ar.id) AS decisions_json FROM approval_requests ar WHERE ar.settlement_id = ?`,
      )
      .bind(settlementId),
    database
      .prepare(
        "SELECT * FROM settlement_state_transitions WHERE settlement_id = ? ORDER BY to_version",
      )
      .bind(settlementId),
    database
      .prepare(
        "SELECT * FROM audit_events WHERE organisation_id = ? AND correlation_id = ? ORDER BY occurred_at, id",
      )
      .bind(organisationId, correlationId),
    database
      .prepare(
        `SELECT rr.* FROM reconciliation_records rr JOIN settlement_distributions sd ON sd.id = rr.settlement_distribution_id WHERE sd.settlement_id = ? ORDER BY sd.position`,
      )
      .bind(settlementId),
    database
      .prepare(
        `SELECT spt.*, sd.id AS distribution_id,
                p.display_name AS beneficiary_name
         FROM settlement_provider_transactions spt
         JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
         JOIN settlement_distributions sd
           ON sd.id = sa.settlement_distribution_id
         JOIN participants p ON p.id = sd.beneficiary_id
         WHERE sd.settlement_id = ? ORDER BY sd.position, sa.attempt_number`,
      )
      .bind(settlementId),
    database
      .prepare(
        `SELECT sa.id, sa.attempt_number, sa.idempotency_key, sa.status,
                sa.error_code, sa.error_message, sa.started_at, sa.completed_at,
                sd.id AS distribution_id, p.display_name AS beneficiary_name
         FROM settlement_attempts sa
         JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
         JOIN participants p ON p.id = sd.beneficiary_id
         WHERE sd.settlement_id = ? ORDER BY sd.position, sa.attempt_number`,
      )
      .bind(settlementId),
    database
      .prepare(
        `SELECT je.*,
                (SELECT json_group_array(json_object(
                  'id', jl.id, 'position', jl.position,
                  'accountId', jl.ledger_account_id,
                  'direction', jl.direction, 'assetCode', jl.asset_code,
                  'atomicAmount', jl.amount_atomic, 'scale', jl.asset_scale,
                  'memo', jl.memo
                )) FROM journal_lines jl
                WHERE jl.journal_entry_id = je.id ORDER BY jl.position) AS lines_json
         FROM journal_entries je
         WHERE je.organisation_id = ?
           AND je.source_type = 'SETTLEMENT' AND je.source_id = ?
         ORDER BY je.created_at, je.id`,
      )
      .bind(organisationId, settlementId),
  ]);
  const distributions = results[0]!;
  const approvals = results[1]!;
  const transitions = results[2]!;
  const audit = results[3]!;
  const reconciliations = results[4]!;
  const providerTransactions = results[5]!;
  const settlementAttempts = results[6]!;
  const journalEntries = results[7]!;
  return json({
    settlement,
    distributions: distributions.results,
    approvals: approvals.results,
    transitions: transitions.results,
    audit: audit.results,
    reconciliations: reconciliations.results,
    providerTransactions: providerTransactions.results,
    settlementAttempts: settlementAttempts.results,
    journalEntries: journalEntries.results,
  });
}

async function escrowDetails(
  database: D1Database,
  organisationId: string,
  escrowId: string,
): Promise<Response> {
  const escrow = await database
    .prepare(
      `SELECT ea.*, p.external_reference AS funding_reference,
              p.status AS funding_status
       FROM escrow_arrangements ea
       JOIN payments p ON p.id = ea.funding_payment_id
       WHERE ea.id = ? AND ea.organisation_id = ?`,
    )
    .bind(escrowId, organisationId)
    .first<Record<string, unknown>>();
  if (!escrow) {
    return json(
      { error: { code: "NOT_FOUND", message: "Escrow not found." } },
      { status: 404 },
    );
  }
  const results = await database.batch<unknown>([
    database
      .prepare(
        `SELECT em.*, emv.id AS verification_id,
                emv.verified_by, emv.evidence_json, emv.verified_at,
                emv.business_event_id, s.id AS settlement_id,
                s.state AS settlement_state, emr.id AS release_id,
                emr.released_at
         FROM escrow_milestones em
         LEFT JOIN escrow_milestone_verifications emv
           ON emv.escrow_milestone_id = em.id
         LEFT JOIN settlements s ON s.source_event_id = emv.business_event_id
         LEFT JOIN escrow_milestone_releases emr
           ON emr.escrow_milestone_id = em.id
         WHERE em.escrow_arrangement_id = ? ORDER BY em.position`,
      )
      .bind(escrowId),
    database
      .prepare(
        `SELECT * FROM escrow_state_transitions
         WHERE organisation_id = ? AND escrow_arrangement_id = ?
         ORDER BY to_version`,
      )
      .bind(organisationId, escrowId),
    database
      .prepare(
        `SELECT * FROM audit_events
         WHERE organisation_id = ? AND (
           (aggregate_type = 'ESCROW' AND aggregate_id = ?)
           OR (aggregate_type = 'ESCROW_MILESTONE' AND aggregate_id IN (
             SELECT id FROM escrow_milestones WHERE escrow_arrangement_id = ?
           ))
         ) ORDER BY occurred_at, id`,
      )
      .bind(organisationId, escrowId, escrowId),
  ]);
  return json({
    escrow,
    milestones: results[0]!.results,
    transitions: results[1]!.results,
    audit: results[2]!.results,
  });
}

function firstCount(result: D1Result<unknown>): number {
  const row = result.results[0] as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 32_768) throw new TypeError("Request body is too large.");
  const value = await request.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requireRequestId(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > 160) {
    throw new TypeError("A valid Idempotency-Key header is required.");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Optional text values must be non-empty strings.");
  }
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required.`);
  }
  return value.trim();
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer.`);
  }
  return value;
}

function requiredObjectArray(
  value: unknown,
  label: string,
): readonly Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "object" || item === null || Array.isArray(item),
    )
  ) {
    throw new TypeError(`${label} must be a non-empty array of objects.`);
  }
  return value as Record<string, unknown>[];
}

function requiredJsonValue(value: unknown, label: string): JsonValue {
  if (value === undefined) throw new TypeError(`${label} is required.`);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} is invalid.`);
  return JSON.parse(serialized) as JsonValue;
}

function isEscrowAction(
  value: unknown,
): value is TransitionEscrowCommand["action"] {
  return (
    value === "ACTIVATE" ||
    value === "CONFIRM_FUNDING" ||
    value === "OPEN_DISPUTE" ||
    value === "RESOLVE_TO_FUNDED" ||
    value === "RESOLVE_TO_PARTIALLY_RELEASED" ||
    value === "CANCEL"
  );
}

function stringifyJson(value: unknown, label: string): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError(`${label} is required.`);
  return result;
}

function apiError(error: unknown): Response {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "Unexpected error.";
  if (error instanceof AuthenticationError) {
    return json(
      { error: { code: "UNAUTHENTICATED", message } },
      { status: 401 },
    );
  }
  if (error instanceof AuthorizationError) {
    return json({ error: { code: "FORBIDDEN", message } }, { status: 403 });
  }
  if (
    error instanceof TypeError ||
    [
      "ApprovalPolicyError",
      "RuleEvaluationError",
      "DistributionCalculationError",
      "StoredConfigurationError",
      "EscrowConfigurationError",
      "InvalidEscrowTransitionError",
    ].includes(name)
  ) {
    return json(
      { error: { code: "INVALID_REQUEST", message } },
      { status: 400 },
    );
  }
  if (name.endsWith("ConflictError")) {
    return json({ error: { code: "CONFLICT", message } }, { status: 409 });
  }
  if (
    name.endsWith("UnavailableError") ||
    name.endsWith("NotAuthorizedError")
  ) {
    return json({ error: { code: "UNPROCESSABLE", message } }, { status: 422 });
  }
  console.error(
    JSON.stringify({ message: "api_request_failed", error: message }),
  );
  return json(
    { error: { code: "INTERNAL", message: "Internal server error." } },
    { status: 500 },
  );
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
