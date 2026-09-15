export type ApiErrorBody = Readonly<{
  error?: Readonly<{ code?: string; message?: string }>;
}>;

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function organisationId(): string {
  const stored = localStorage.getItem("flowpay.organisationId");
  if (stored) return stored;
  const configured: unknown = import.meta.env.VITE_FLOWPAY_ORGANISATION_ID;
  return typeof configured === "string" ? configured : "";
}

export function setOrganisationId(value: string): void {
  localStorage.setItem("flowpay.organisationId", value.trim());
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const selectedOrganisation = organisationId();
  if (!selectedOrganisation) {
    throw new ApiError(
      "Select an organisation before loading business data.",
      400,
      "ORGANISATION_REQUIRED",
    );
  }
  const headers = new Headers(init.headers);
  headers.set("x-organisation-id", selectedOrganisation);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ApiError(
      body.error?.message ?? "The request could not be completed.",
      response.status,
      body.error?.code ?? "REQUEST_FAILED",
    );
  }
  return body;
}

export function mutationHeaders(requestId = crypto.randomUUID()): HeadersInit {
  return { "idempotency-key": requestId };
}
