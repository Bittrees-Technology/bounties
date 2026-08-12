import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";

import { describe, expect, it, vi } from "vitest";

const handleApiRequestMock = vi.fn();

import { handleDevelopmentApi } from "./devApiMiddleware";

class LocalRequest extends EventEmitter {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: IncomingHttpHeaders,
    private readonly payload?: string
  ) {
    super();
  }

  start() {
    queueMicrotask(() => {
      if (this.payload) this.emit("data", Buffer.from(this.payload));
      this.emit("end");
    });
  }
}

class LocalResponse {
  statusCode = 200;
  readonly headers = new Map<string, string | readonly string[]>();
  body: Uint8Array<ArrayBufferLike> = new Uint8Array();

  setHeader(name: string, value: string | readonly string[]) {
    this.headers.set(name, value);
  }

  end(body?: Uint8Array) {
    this.body = body ?? new Uint8Array();
  }
}

describe("local same-origin API adapter", () => {
  it("passes the original API route, method, origin, headers, and body to the Vercel handler", async () => {
    handleApiRequestMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    }));
    const payload = JSON.stringify({ action: "nonce" });
    const request = new LocalRequest("POST", "/api/wallet-auth", {
      host: "localhost:5173",
      origin: "http://localhost:5173",
      "content-type": "application/json"
    }, payload);
    const response = new LocalResponse();

    const result = handleDevelopmentApi(request, response, handleApiRequestMock);
    request.start();
    await result;

    const forwarded = handleApiRequestMock.mock.calls[0][0] as Request;
    expect(forwarded.url).toBe("http://localhost:5173/api/wallet-auth");
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("origin")).toBe("http://localhost:5173");
    await expect(forwarded.json()).resolves.toEqual({ action: "nonce" });
    expect(response.statusCode).toBe(201);
    expect(new TextDecoder().decode(response.body)).toBe(JSON.stringify({ ok: true }));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a generic fail-closed response if the local adapter fails", async () => {
    handleApiRequestMock.mockRejectedValue(new Error("sensitive local detail"));
    const request = new LocalRequest("GET", "/api/bounties", { host: "localhost:5173" });
    const response = new LocalResponse();

    await handleDevelopmentApi(request, response, handleApiRequestMock);

    expect(response.statusCode).toBe(503);
    expect(new TextDecoder().decode(response.body)).toBe(JSON.stringify({ code: "SERVICE_UNAVAILABLE" }));
  });
});
