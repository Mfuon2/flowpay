# FlowPay Deployment Checklist

## Environment isolation

Use separate Cloudflare D1 databases, queues/DLQs, Access applications, and Circle credentials/wallets for local, preview, testnet demo, and any future production environment. Never point a preview build at production financial resources.

## Build and data

- `npm ci`
- `npm run validate`
- review every unapplied D1 migration and back up material data;
- apply migrations to the explicit target environment;
- seed Metro Auto Works only in an isolated demo environment;
- run the health endpoint and authenticated tenant smoke tests.

## Access and authorization

- Configure `TEAM_DOMAIN` and `POLICY_AUD` for the exact Cloudflare Access application.
- Verify unauthenticated `/api/v1/*` requests fail closed.
- Verify active membership, tenant selection, finance/manager roles, and maker-checker behavior with separate accounts.
- Confirm the public route is protected before sharing its URL.

## Provider modes

### Deterministic demo

Set `FLOWPAY_PROVIDER=simulation` and an approved `FLOWPAY_SIMULATION_BEHAVIOR`. Do not describe these transactions as testnet or real.

### Circle Wallets / Arc Testnet

Re-open current official Circle/Arc documentation before configuration.

- Set `FLOWPAY_PROVIDER=circle-wallets` as a non-secret environment variable.
- Store `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` with Cloudflare secret bindings.
- Set `CIRCLE_USDC_TOKEN_ID` to Circle's current Arc Testnet USDC token UUID, not the contract address.
- Keep `CIRCLE_API_BASE_URL` unset unless an approved Circle-compatible test endpoint is intentionally used.
- Configure active provider sources with Circle wallet UUIDs and participant destinations with Arc Testnet addresses.
- Fund only dedicated test wallets with testnet USDC and retain enough balance for Arc gas.
- Run one low-value transfer, poll to Circle `COMPLETE`, record the Arc transaction reference and fee evidence, then test replay.
- Keep signed Circle callbacks disabled until the current exact signature contract is implemented and tested.

## Release decision

Release only when:

- the Operations page has no unexplained critical items;
- simulation success/failure/ambiguous paths have been rehearsed;
- the flagship accounting presentation is reviewed for the demo;
- testnet disclosure is visible and in the spoken script;
- rollback/provider-disable ownership is assigned;
- no secrets or credentials appear in source, build output, logs, browser assets, seed files, or audit evidence.
