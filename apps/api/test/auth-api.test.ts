import { env } from "cloudflare:workers";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
} from "jose";
import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  AuthorizationError,
  authenticateOrganisationRequest,
  type AuthenticatedPrincipal,
} from "../src/auth/access-auth.ts";
import { handleApiRequest } from "../src/http/api.ts";

const now = "2026-09-14T12:00:00Z";

async function accessFixture(suffix: string) {
  const organisationId = `org-auth-${suffix}`;
  const userId = `user-auth-${suffix}`;
  const membershipId = `membership-auth-${suffix}`;
  const subject = `access-subject-${suffix}`;
  const email = `${suffix}@example.com`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, `Auth organisation ${suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO application_users (
        id, access_subject, email, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(userId, subject, email, now, now),
    env.DB.prepare(
      `INSERT INTO organisation_memberships (
        id, organisation_id, user_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(membershipId, organisationId, userId, now, now),
    env.DB.prepare(
      `INSERT INTO organisation_membership_roles (
        membership_id, role, granted_at
      ) VALUES (?, 'FINANCE', ?)`,
    ).bind(membershipId, now),
  ]);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = `key-${suffix}`;
  jwk.use = "sig";
  jwk.alg = "RS256";
  const issuer = "https://flowpay-test.cloudflareaccess.com";
  const audience = "flowpay-test-audience";
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const keySet: JSONWebKeySet = { keys: [jwk] };
  const authEnv = {
    DB: env.DB,
    TEAM_DOMAIN: issuer,
    POLICY_AUD: audience,
  } as unknown as Env;
  return {
    organisationId,
    userId,
    subject,
    email,
    token,
    authEnv,
    keyResolver: createLocalJWKSet(keySet),
  };
}

describe("Cloudflare Access authentication", () => {
  it("verifies signature, issuer, audience, identity, membership, and roles", async () => {
    const fixture = await accessFixture("valid");
    const request = new Request("https://flowpay.test/api/v1/me", {
      headers: {
        "cf-access-jwt-assertion": fixture.token,
        "x-organisation-id": fixture.organisationId,
      },
    });
    await expect(
      authenticateOrganisationRequest(
        request,
        fixture.authEnv,
        fixture.keyResolver,
      ),
    ).resolves.toMatchObject({
      userId: fixture.userId,
      subject: fixture.subject,
      email: fixture.email,
      organisationId: fixture.organisationId,
      roles: ["FINANCE"],
    });
  });

  it("rejects invalid tokens and cross-organisation selection", async () => {
    const fixture = await accessFixture("rejection");
    const crossTenant = new Request("https://flowpay.test/api/v1/me", {
      headers: {
        "cf-access-jwt-assertion": fixture.token,
        "x-organisation-id": "another-organisation",
      },
    });
    await expect(
      authenticateOrganisationRequest(
        crossTenant,
        fixture.authEnv,
        fixture.keyResolver,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const invalid = new Request("https://flowpay.test/api/v1/me", {
      headers: {
        "cf-access-jwt-assertion": `${fixture.token}changed`,
        "x-organisation-id": fixture.organisationId,
      },
    });
    await expect(
      authenticateOrganisationRequest(
        invalid,
        fixture.authEnv,
        fixture.keyResolver,
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("authenticated API", () => {
  it("requires Access authentication on every v1 route", async () => {
    const response = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/dashboard", {
        headers: { "x-organisation-id": "org-missing-auth" },
      }),
      env,
    );
    expect(response?.status).toBe(401);
  });

  it("scopes collection queries to the authorized organisation", async () => {
    const fixture = await accessFixture("api-scope");
    const otherOrganisationId = "org-auth-api-scope-other";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(otherOrganisationId, "Other organisation", now, now),
      env.DB.prepare(
        `INSERT INTO customers (
          id, organisation_id, display_name, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      ).bind(
        "customer-visible",
        fixture.organisationId,
        "Visible customer",
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO customers (
          id, organisation_id, display_name, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      ).bind(
        "customer-hidden",
        otherOrganisationId,
        "Hidden customer",
        now,
        now,
      ),
    ]);
    const principal: AuthenticatedPrincipal = {
      userId: fixture.userId,
      subject: fixture.subject,
      email: fixture.email,
      organisationId: fixture.organisationId,
      membershipId: "membership-auth-api-scope",
      roles: ["FINANCE"],
    };
    const response = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/customers"),
      env,
      () => Promise.resolve(principal),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { items: { id: string }[] };
    expect(body.items.map(({ id }) => id)).toContain("customer-visible");
    expect(body.items.map(({ id }) => id)).not.toContain("customer-hidden");
  });

  it("authorizes job creation and lifecycle commands from server-side roles", async () => {
    const fixture = await accessFixture("job-command");
    const customerId = "customer-auth-job-command";
    await env.DB.prepare(
      `INSERT INTO customers (
        id, organisation_id, display_name, status, created_at, updated_at
      ) VALUES (?, ?, 'Job customer', 'ACTIVE', ?, ?)`,
    )
      .bind(customerId, fixture.organisationId, now, now)
      .run();
    const principal: AuthenticatedPrincipal = {
      userId: fixture.userId,
      subject: fixture.subject,
      email: fixture.email,
      organisationId: fixture.organisationId,
      membershipId: "membership-auth-job-command",
      roles: ["OPERATIONS"],
    };
    const authenticate = () => Promise.resolve(principal);
    const created = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-create-job-command",
        },
        body: JSON.stringify({
          customerId,
          reference: "JOB-API-001",
          title: "API-created work",
        }),
      }),
      env,
      authenticate,
    );
    expect(created?.status).toBe(201);
    const job = (await created?.json()) as { id: string; status: string };
    expect(job.status).toBe("DRAFT");
    const started = await handleApiRequest(
      new Request(
        `https://flowpay.test/api/v1/jobs/${encodeURIComponent(job.id)}/transitions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "api-start-job-command",
          },
          body: JSON.stringify({ action: "START" }),
        },
      ),
      env,
      authenticate,
    );
    expect(started?.status).toBe(201);
    await expect(started?.json()).resolves.toMatchObject({
      id: job.id,
      status: "IN_PROGRESS",
    });

    const financePrincipal = { ...principal, roles: ["FINANCE"] };
    const forbidden = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-forbidden-job-command",
        },
        body: JSON.stringify({
          customerId,
          reference: "JOB-API-002",
          title: "Unauthorized work",
        }),
      }),
      env,
      () => Promise.resolve(financePrincipal),
    );
    expect(forbidden?.status).toBe(403);
  });

  it("publishes validated policy and rule drafts through maker-checker APIs", async () => {
    const fixture = await accessFixture("configuration-api");
    const author: AuthenticatedPrincipal = {
      userId: fixture.userId,
      subject: fixture.subject,
      email: fixture.email,
      organisationId: fixture.organisationId,
      membershipId: "membership-auth-configuration-api",
      roles: ["FINANCE"],
    };
    const reviewer: AuthenticatedPrincipal = {
      ...author,
      userId: "configuration-reviewer",
    };
    const policyResponse = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/approval-policies", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-create-approval-policy",
        },
        body: JSON.stringify({
          name: "API finance approval",
          assetCode: "USD",
          assetScale: 2,
          bands: [
            {
              minAtomicAmount: "0",
              maxAtomicAmount: null,
              mode: "APPROVAL_REQUIRED",
              requirements: [
                { role: "FINANCE", count: 1, allowSelfApproval: false },
              ],
            },
          ],
        }),
      }),
      env,
      () => Promise.resolve(author),
    );
    expect(policyResponse?.status).toBe(201);
    const policy = (await policyResponse?.json()) as {
      id: string;
      versionId: string;
    };
    const selfActivation = await handleApiRequest(
      new Request(
        `https://flowpay.test/api/v1/approval-policies/${encodeURIComponent(policy.id)}/transitions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "api-self-activate-policy",
          },
          body: JSON.stringify({ action: "ACTIVATE" }),
        },
      ),
      env,
      () => Promise.resolve(author),
    );
    expect(selfActivation?.status).toBe(422);
    const activated = await handleApiRequest(
      new Request(
        `https://flowpay.test/api/v1/approval-policies/${encodeURIComponent(policy.id)}/transitions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "api-reviewer-activate-policy",
          },
          body: JSON.stringify({ action: "ACTIVATE" }),
        },
      ),
      env,
      () => Promise.resolve(reviewer),
    );
    expect(activated?.status).toBe(201);
    const participantIds = ["one", "two"].map(
      (name) => `participant-configuration-api-${name}`,
    );
    await env.DB.batch(
      participantIds.map((id) =>
        env.DB.prepare(
          `INSERT INTO participants (
            id, organisation_id, display_name, participant_type, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'CONTRACTOR', 'ACTIVE', ?, ?)`,
        ).bind(id, fixture.organisationId, id, now, now),
      ),
    );
    const ruleResponse = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/settlement-rules", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-create-settlement-rule",
        },
        body: JSON.stringify({
          name: "API generic split",
          triggerEventType: "PAYMENT_CONFIRMED",
          triggerSchemaVersion: 1,
          priority: 100,
          effectiveFrom: now,
          conditions: [
            { fact: "job.status", operator: "EQUALS", value: "COMPLETED" },
          ],
          beneficiaries: [
            {
              kind: "PERCENTAGE",
              beneficiaryId: participantIds[0],
              basisPoints: 7000,
            },
            { kind: "REMAINDER", beneficiaryId: participantIds[1] },
          ],
          providerPolicy: {
            providerKey: "simulation",
            network: "simnet",
            method: "INDIVIDUAL_TRANSFERS",
          },
          approvalPolicyVersionId: policy.versionId,
        }),
      }),
      env,
      () => Promise.resolve(author),
    );
    expect(ruleResponse?.status).toBe(201);
  });
});
