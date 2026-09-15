import { spawnSync } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DEPLOYMENT_PROVIDERS,
  SECRET_REQUIREMENTS,
  assertProvider,
  deploymentVariables,
  parseSecretNames,
  requiredSecretNames,
} from "./deploy-config.mjs";

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const apiDirectory = path.join(repositoryDirectory, "apps", "api");

async function main() {
  const provider = await selectProvider();
  const required = requiredSecretNames(provider);
  let configured = listSecrets();
  const missing = required.filter((name) => !configured.has(name));

  if (missing.length > 0 && !process.stdin.isTTY) {
    throw new Error(
      `Missing Cloudflare secrets: ${missing.join(", ")}. Run npm run deploy interactively so Wrangler can store them securely.`,
    );
  }

  for (const name of missing) {
    process.stdout.write(`\nMissing ${name}\n${SECRET_REQUIREMENTS[name]}\n`);
    process.stdout.write(
      "Wrangler will now prompt for the value and create the encrypted binding directly on Cloudflare.\n",
    );
    runWrangler(["secret", "put", name]);
  }

  configured = listSecrets();
  const stillMissing = required.filter((name) => !configured.has(name));
  if (stillMissing.length > 0) {
    throw new Error(
      `Cloudflare did not report the required secrets: ${stillMissing.join(", ")}. Deployment stopped.`,
    );
  }

  run("npm", ["run", "validate"], repositoryDirectory);
  runWrangler(["d1", "migrations", "apply", "flowpay", "--remote"]);

  const deployArguments = ["deploy"];
  for (const variable of deploymentVariables(provider)) {
    deployArguments.push("--var", variable);
  }
  runWrangler(deployArguments);
}

async function selectProvider() {
  const configured = process.env.FLOWPAY_DEPLOY_PROVIDER?.trim();
  if (configured) {
    assertProvider(configured);
    return configured;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "Set FLOWPAY_DEPLOY_PROVIDER to simulation or circle-wallets for a non-interactive deployment.",
    );
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await prompt.question(
        `Settlement provider (${DEPLOYMENT_PROVIDERS.join(" / ")}): `,
      )
    ).trim();
    assertProvider(answer);
    return answer;
  } finally {
    prompt.close();
  }
}

function listSecrets() {
  const result = spawnSync(
    "npx",
    ["wrangler", "secret", "list", "--format", "json"],
    {
      cwd: apiDirectory,
      encoding: "utf8",
      shell: false,
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error("Unable to read the flowpay-api secrets from Cloudflare.");
  }
  return parseSecretNames(result.stdout);
}

function runWrangler(arguments_) {
  run("npx", ["wrangler", ...arguments_], apiDirectory);
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, {
    cwd,
    shell: false,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed.`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `\nDeployment stopped: ${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exitCode = 1;
});
