import {
  PermanentQueueMessageError,
  consumeFlowPayMessage,
  recordPermanentQueueFailure,
} from "./messaging/consumer.ts";
import {
  dispatchPendingOutbox,
  type FlowPayQueueMessage,
} from "./messaging/outbox.ts";
import { processAccountingWorkItem } from "./accounting/process-accounting-work-item.ts";
import { processPaymentConfirmedMessage } from "./business/process-payment-confirmed-message.ts";
import { processInvoiceIssuedMessage } from "./business/process-invoice-issued-message.ts";
import { processQuoteApprovedMessage } from "./business/process-quote-approved-message.ts";
import { processBusinessEventAccounting } from "./accounting/process-business-event-accounting.ts";
import { processSettlementObligation } from "./accounting/process-settlement-obligation.ts";
import { executeSettlementWorkItem } from "./flowpay/execute-settlement-work-item.ts";
import { processDueSettlementWork } from "./flowpay/process-due-settlement-work.ts";
import { processDueProviderObservations } from "./flowpay/process-due-provider-observations.ts";
import { processEscrowSettlementConfirmed } from "./flowpay/process-escrow-release.ts";
import { configuredProvider } from "./flowpay/configured-provider.ts";
import { handleApiRequest } from "./http/api.ts";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    const database = await env.DB.prepare("SELECT 1 AS ok").first<{
      ok: number;
    }>();
    return json({
      ok: database?.ok === 1,
      service: "flowpay-api",
    });
  }

  const apiResponse = await handleApiRequest(request, env);
  if (apiResponse) return apiResponse;

  return json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "request_failed",
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      return json({ error: "Internal server error" }, { status: 500 });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await dispatchPendingOutbox(env.DB, env.FLOWPAY_EVENTS);
    console.log(
      JSON.stringify({ message: "outbox_dispatch_complete", ...result }),
    );
    const configured = configuredProvider(env);
    if (configured) {
      const settlementWork = await processDueSettlementWork(
        env.DB,
        configured.key,
        configured.provider,
      );
      console.log(
        JSON.stringify({
          message: "due_settlement_work_complete",
          ...settlementWork,
        }),
      );
      const observations = await processDueProviderObservations(
        env.DB,
        configured.key,
        configured.provider,
      );
      console.log(
        JSON.stringify({
          message: "due_provider_observations_complete",
          ...observations,
        }),
      );
    }
  },
  async queue(
    batch: MessageBatch<FlowPayQueueMessage>,
    env: Env,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await consumeFlowPayMessage(env.DB, message.body);
        if (message.body.messageType === "BUSINESS_INVOICE_ISSUED") {
          const result = await processInvoiceIssuedMessage(
            env.DB,
            message.body,
          );
          await processBusinessEventAccounting(env.DB, result.eventId);
        }
        if (message.body.messageType === "BUSINESS_QUOTE_APPROVED") {
          await processQuoteApprovedMessage(env.DB, message.body);
        }
        if (message.body.messageType === "BUSINESS_PAYMENT_CONFIRMED") {
          const result = await processPaymentConfirmedMessage(
            env.DB,
            message.body,
          );
          await processBusinessEventAccounting(env.DB, result.eventId);
        }
        if (message.body.messageType === "FLOWPAY_SETTLEMENT_CREATED") {
          await processSettlementObligation(env.DB, message.body);
        }
        if (message.body.messageType === "FLOWPAY_SETTLEMENT_READY") {
          const configured = configuredProvider(env);
          if (
            configured &&
            (await workItemUsesProvider(
              env.DB,
              message.body.messageId,
              configured.key,
            ))
          ) {
            await executeSettlementWorkItem(
              env.DB,
              message.body.messageId,
              configured.key,
              configured.provider,
            );
          }
        }
        if (message.body.messageType === "FLOWPAY_SETTLEMENT_CONFIRMED") {
          await processAccountingWorkItem(env.DB, message.body.messageId);
          const payload = JSON.parse(message.body.payloadJson) as unknown;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "settlementId" in payload &&
            typeof payload.settlementId === "string"
          ) {
            await processEscrowSettlementConfirmed(
              env.DB,
              payload.settlementId,
            );
          }
        }
        message.ack();
      } catch (error) {
        if (error instanceof PermanentQueueMessageError) {
          await recordPermanentQueueFailure(
            env.DB,
            batch.queue,
            message.id,
            message.attempts,
            error,
            message.body.organisationId,
          );
          console.error(
            JSON.stringify({
              message: "queue_message_rejected",
              queue: batch.queue,
              queueMessageId: message.id,
              error: error.message,
            }),
          );
          message.ack();
        } else {
          console.error(
            JSON.stringify({
              message: "queue_message_retry",
              queue: batch.queue,
              queueMessageId: message.id,
              attempts: message.attempts,
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
          message.retry({
            delaySeconds: Math.min(30 * 2 ** message.attempts, 43_200),
          });
        }
      }
    }
  },
} satisfies ExportedHandler<Env, FlowPayQueueMessage>;

async function workItemUsesProvider(
  database: D1Database,
  workItemId: string,
  providerKey: string,
): Promise<boolean> {
  const configuredProviderKey = await database
    .prepare(
      `SELECT json_extract(srv.provider_policy_json, '$.providerKey') AS provider_key
       FROM settlement_work_items wi
       JOIN settlements s ON s.id = wi.settlement_id
       JOIN settlement_rule_versions srv ON srv.id = s.rule_version_id
       WHERE wi.id = ?`,
    )
    .bind(workItemId)
    .first<string>("provider_key");
  return configuredProviderKey === providerKey;
}
