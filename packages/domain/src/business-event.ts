export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type BusinessEvent<TPayload extends JsonValue = JsonValue> = Readonly<{
  id: string;
  organisationId: string;
  source: string;
  externalEventId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  recordedAt: string;
  correlationId: string;
  causationId?: string;
  payload: TPayload;
}>;

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}

function requireUtcTimestamp(label: string, value: string): void {
  if (!ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO 8601 UTC timestamp.`);
  }
}

export function createBusinessEvent<TPayload extends JsonValue>(
  event: BusinessEvent<TPayload>,
): BusinessEvent<TPayload> {
  requireIdentifier("Event ID", event.id);
  requireIdentifier("Organisation ID", event.organisationId);
  requireIdentifier("Source", event.source);
  requireIdentifier("External event ID", event.externalEventId);
  requireIdentifier("Event type", event.eventType);
  requireIdentifier("Aggregate type", event.aggregateType);
  requireIdentifier("Aggregate ID", event.aggregateId);
  requireIdentifier("Correlation ID", event.correlationId);
  if (event.causationId !== undefined) {
    requireIdentifier("Causation ID", event.causationId);
  }
  if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) {
    throw new TypeError("Event schema version must be a positive integer.");
  }
  requireUtcTimestamp("Occurred at", event.occurredAt);
  requireUtcTimestamp("Recorded at", event.recordedAt);

  return Object.freeze({ ...event });
}
