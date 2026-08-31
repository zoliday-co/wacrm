import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Meta's edge started answering every JSON-bodied send from our number
 * with HTTP 500 `code 1` while accepting the identical params
 * form-encoded. The sender retries in the other encoding when a failure
 * implicates the transport — and must NOT retry when Meta actually
 * rejected the payload, or a bad message would go out twice.
 *
 * Each test imports the module fresh: the working encoding latches at
 * module scope, so a leaked latch would make these pass for the wrong
 * reason.
 */

const ARGS = {
  phoneNumberId: "PNID",
  accessToken: "TOKEN",
  to: "919999999999",
  text: "hello",
};

function contentTypeOf(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers["Content-Type"] ?? "";
}

const ACCEPTED = JSON.stringify({ messages: [{ id: "wamid.OK" }] });
const failure = (code: number) =>
  JSON.stringify({ error: { message: "An unknown error has occurred.", code } });

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("send transport encoding", () => {
  it("retries form-encoded when JSON gets HTTP 500 code 1, and succeeds", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const ct = contentTypeOf(init);
        calls.push(ct);
        const isJson = ct.includes("application/json");
        return {
          ok: !isJson,
          status: isJson ? 500 : 200,
          text: async () => (isJson ? failure(1) : ACCEPTED),
        } as Response;
      }),
    );
    const { sendTextMessage } = await import("./meta-api");
    await expect(sendTextMessage(ARGS)).resolves.toEqual({ messageId: "wamid.OK" });
    expect(calls).toEqual([
      "application/json",
      "application/x-www-form-urlencoded",
    ]);
  });

  it("latches the working encoding so only the first send pays two round trips", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const ct = contentTypeOf(init);
        calls.push(ct);
        const isJson = ct.includes("application/json");
        return {
          ok: !isJson,
          status: isJson ? 500 : 200,
          text: async () => (isJson ? failure(1) : ACCEPTED),
        } as Response;
      }),
    );
    const { sendTextMessage } = await import("./meta-api");
    await sendTextMessage(ARGS);
    await sendTextMessage(ARGS);
    // First send: JSON then the form retry. Second: form only.
    expect(calls).toEqual([
      "application/json",
      "application/x-www-form-urlencoded",
      "application/x-www-form-urlencoded",
    ]);
  });

  it("does NOT retry a rejected payload — a 400 code 100 must send once", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(contentTypeOf(init));
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              error: { message: "(#100) Param text is required", code: 100 },
            }),
        } as Response;
      }),
    );
    const { sendTextMessage } = await import("./meta-api");
    await expect(sendTextMessage(ARGS)).rejects.toThrow(/code 100/);
    expect(calls).toHaveLength(1);
  });

  it("form-encodes nested objects as JSON strings, which is what Graph expects", async () => {
    let formBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const isJson = contentTypeOf(init).includes("application/json");
        if (!isJson) formBody = init?.body as string;
        return {
          ok: !isJson,
          status: isJson ? 500 : 200,
          text: async () => (isJson ? failure(1) : ACCEPTED),
        } as Response;
      }),
    );
    const { sendTextMessage } = await import("./meta-api");
    await sendTextMessage(ARGS);
    const parsed = new URLSearchParams(formBody);
    expect(parsed.get("messaging_product")).toBe("whatsapp");
    expect(parsed.get("to")).toBe("919999999999");
    expect(JSON.parse(parsed.get("text")!)).toEqual({ body: "hello" });
  });
});
