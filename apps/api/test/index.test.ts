import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("FlowPay API", () => {
  it("reports the service and D1 binding as healthy", async () => {
    const response = await exports.default.fetch(
      "https://flowpay.test/api/health",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "flowpay-api",
    });
  });

  it("returns a structured no-store response for unknown routes", async () => {
    const response = await exports.default.fetch(
      "https://flowpay.test/api/missing",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});
