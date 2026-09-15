import {
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

export type AuthenticatedPrincipal = Readonly<{
  userId: string;
  subject: string;
  email: string;
  organisationId: string;
  membershipId: string;
  roles: readonly OrganisationRole[];
}>;

export const ORGANISATION_ROLES = [
  "OWNER",
  "ADMIN",
  "FINANCE",
  "MANAGER",
  "OPERATIONS",
  "ACCOUNTANT",
  "VIEWER",
] as const;

export type OrganisationRole = (typeof ORGANISATION_ROLES)[number];

export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}

export class AuthorizationError extends Error {
  override readonly name = "AuthorizationError";
}

type AccessConfiguration = Readonly<{
  teamDomain: string;
  policyAudience: string;
}>;

type MembershipRow = Readonly<{
  user_id: string;
  access_subject: string;
  email: string;
  membership_id: string;
  role: string;
}>;

export async function authenticateOrganisationRequest(
  request: Request,
  env: Env,
  keyResolver?: JWTVerifyGetKey,
): Promise<AuthenticatedPrincipal> {
  const organisationId = request.headers.get("x-organisation-id")?.trim();
  if (!organisationId) {
    throw new AuthorizationError("An organisation selection is required.");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new AuthenticationError(
      "Cloudflare Access authentication is required.",
    );
  }
  const configuration = accessConfiguration(env);
  const payload = await verifyAccessJwt(token, configuration, keyResolver);
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AuthenticationError("Access token has no subject identity.");
  }
  const email =
    typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (!email) {
    throw new AuthenticationError("Access token has no email identity.");
  }
  const rows = await env.DB.prepare(
    `SELECT u.id AS user_id, u.access_subject, u.email,
            om.id AS membership_id, omr.role
     FROM application_users u
     JOIN organisation_memberships om ON om.user_id = u.id
     JOIN organisation_membership_roles omr ON omr.membership_id = om.id
     WHERE u.access_subject = ? AND lower(u.email) = ?
       AND u.status = 'ACTIVE' AND om.organisation_id = ?
       AND om.status = 'ACTIVE'
     ORDER BY omr.role`,
  )
    .bind(payload.sub, email, organisationId)
    .all<MembershipRow>();
  const first = rows.results[0];
  if (!first) {
    throw new AuthorizationError(
      "The authenticated user is not an active member of this organisation.",
    );
  }
  const roles = rows.results.map(({ role }) => parseRole(role));
  return {
    userId: first.user_id,
    subject: first.access_subject,
    email: first.email,
    organisationId,
    membershipId: first.membership_id,
    roles,
  };
}

export async function verifyAccessJwt(
  token: string,
  configuration: AccessConfiguration,
  keyResolver?: JWTVerifyGetKey,
): Promise<JWTPayload> {
  try {
    const keys =
      keyResolver ??
      createRemoteJWKSet(
        new URL(`${configuration.teamDomain}/cdn-cgi/access/certs`),
      );
    const verified = await jwtVerify(token, keys, {
      issuer: configuration.teamDomain,
      audience: configuration.policyAudience,
      algorithms: ["RS256"],
    });
    return verified.payload;
  } catch {
    throw new AuthenticationError("Cloudflare Access token is invalid.");
  }
}

export function requireAnyRole(
  principal: AuthenticatedPrincipal,
  allowed: readonly OrganisationRole[],
): void {
  if (!principal.roles.some((role) => allowed.includes(role))) {
    throw new AuthorizationError(
      `This action requires one of: ${allowed.join(", ")}.`,
    );
  }
}

function accessConfiguration(env: Env): AccessConfiguration {
  const teamDomain = env.TEAM_DOMAIN?.replace(/\/$/, "");
  const policyAudience = env.POLICY_AUD?.trim();
  if (!teamDomain || !teamDomain.startsWith("https://") || !policyAudience) {
    throw new AuthenticationError(
      "Cloudflare Access authentication is not configured.",
    );
  }
  return { teamDomain, policyAudience };
}

function parseRole(value: string): OrganisationRole {
  if ((ORGANISATION_ROLES as readonly string[]).includes(value)) {
    return value as OrganisationRole;
  }
  throw new AuthorizationError("Membership contains an unsupported role.");
}

export type { JSONWebKeySet };
