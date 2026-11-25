import { describe, expect, it } from "vitest";
import worker from "../src/index";

const call = (path: string, method = "GET") =>
  worker.fetch(
    new Request(`https://ai.example${path}`, { method }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
  );

describe("worker", () => {
  it("reports health", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown routes", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/health", "POST")).status).toBe(404);
  });
});
