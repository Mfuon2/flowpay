import { canonicalJson, hashCanonicalJson } from "../flowpay/canonical-json.ts";
import { auditStatement } from "../flowpay/evidence-statements.ts";

type CommandContext = Readonly<{
  commandId: string;
  organisationId: string;
  actorId: string;
  correlationId: string;
}>;

export type CreateCustomerCommand = CommandContext &
  Readonly<{
    displayName: string;
    email?: string;
    phone?: string;
  }>;

export type CreateParticipantCommand = CommandContext &
  Readonly<{
    displayName: string;
    participantType:
      | "EMPLOYEE"
      | "CONTRACTOR"
      | "SUPPLIER"
      | "REFERRER"
      | "INTERNAL_UNIT";
  }>;

export type CreatePartyResult = Readonly<{
  id: string;
  organisationId: string;
  displayName: string;
  status: "ACTIVE";
  replayed: boolean;
}>;

export class BusinessCommandConflictError extends Error {
  override readonly name = "BusinessCommandConflictError";
}

type ReceiptRow = Readonly<{
  command_type: string;
  command_fingerprint: string;
  result_json: string;
}>;

export async function createCustomer(
  database: D1Database,
  command: CreateCustomerCommand,
): Promise<CreatePartyResult> {
  const normalized = {
    ...validateContext(command),
    displayName: required("Customer name", command.displayName),
    email: optional("Customer email", command.email)?.toLowerCase(),
    phone: optional("Customer phone", command.phone),
  };
  return createParty(database, "CREATE_CUSTOMER", normalized, (id, now) =>
    database
      .prepare(
        `INSERT INTO customers (
          id, organisation_id, display_name, email, phone, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .bind(
        id,
        normalized.organisationId,
        normalized.displayName,
        normalized.email ?? null,
        normalized.phone ?? null,
        now,
        now,
      ),
  );
}

export async function createParticipant(
  database: D1Database,
  command: CreateParticipantCommand,
): Promise<CreatePartyResult> {
  const normalized = {
    ...validateContext(command),
    displayName: required("Participant name", command.displayName),
    participantType: command.participantType,
  };
  if (
    ![
      "EMPLOYEE",
      "CONTRACTOR",
      "SUPPLIER",
      "REFERRER",
      "INTERNAL_UNIT",
    ].includes(normalized.participantType)
  ) {
    throw new TypeError("Participant type is not supported.");
  }
  return createParty(database, "CREATE_PARTICIPANT", normalized, (id, now) =>
    database
      .prepare(
        `INSERT INTO participants (
            id, organisation_id, display_name, participant_type, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .bind(
        id,
        normalized.organisationId,
        normalized.displayName,
        normalized.participantType,
        now,
        now,
      ),
  );
}

async function createParty(
  database: D1Database,
  commandType: "CREATE_CUSTOMER" | "CREATE_PARTICIPANT",
  command: CommandContext & Readonly<{ displayName: string }>,
  recordStatement: (id: string, now: string) => D1PreparedStatement,
): Promise<CreatePartyResult> {
  const fingerprint = await hashCanonicalJson({ commandType, ...command });
  const existing = await findReceipt(database, command.commandId);
  if (existing) return replay(existing, commandType, fingerprint);

  const aggregateType =
    commandType === "CREATE_CUSTOMER" ? "CUSTOMER" : "PARTICIPANT";
  const id = `${aggregateType.toLowerCase()}:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const result: CreatePartyResult = {
    id,
    organisationId: command.organisationId,
    displayName: command.displayName,
    status: "ACTIVE",
    replayed: false,
  };
  try {
    await database.batch([
      recordStatement(id, now),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: command.organisationId,
        actorType: "USER",
        actorId: command.actorId,
        action: `${aggregateType}_CREATED`,
        aggregateType,
        aggregateId: id,
        correlationId: command.correlationId,
        causationId: command.commandId,
        evidence: { displayName: command.displayName },
        occurredAt: now,
      }),
      database
        .prepare(
          `INSERT INTO application_command_receipts (
            id, organisation_id, command_type, command_fingerprint,
            aggregate_type, aggregate_id, result_json, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          command.commandId,
          command.organisationId,
          commandType,
          fingerprint,
          aggregateType,
          id,
          canonicalJson(result),
          now,
        ),
    ]);
  } catch (error) {
    const raced = await findReceipt(database, command.commandId);
    if (raced) return replay(raced, commandType, fingerprint);
    throw error;
  }
  return result;
}

async function findReceipt(
  database: D1Database,
  commandId: string,
): Promise<ReceiptRow | null> {
  return database
    .prepare(
      `SELECT command_type, command_fingerprint, result_json
       FROM application_command_receipts WHERE id = ?`,
    )
    .bind(commandId)
    .first<ReceiptRow>();
}

function replay(
  receipt: ReceiptRow,
  commandType: string,
  fingerprint: string,
): CreatePartyResult {
  if (
    receipt.command_type !== commandType ||
    receipt.command_fingerprint !== fingerprint
  ) {
    throw new BusinessCommandConflictError(
      "The command identity was already used for different business data.",
    );
  }
  const result = JSON.parse(receipt.result_json) as CreatePartyResult;
  return { ...result, replayed: true };
}

function validateContext<T extends CommandContext>(command: T): CommandContext {
  return {
    commandId: required("Command ID", command.commandId),
    organisationId: required("Organisation ID", command.organisationId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
  };
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} is required.`);
  if (normalized.length > 160) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function optional(label: string, value?: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > 254) throw new TypeError(`${label} is too long.`);
  return normalized;
}
