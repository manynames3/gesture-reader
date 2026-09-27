import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchShell = vi.hoisted(() => vi.fn(async () => new Response("reader shell")));
vi.mock("vinext/server/app-router-entry", () => ({ default: { fetch: fetchShell } }));
import worker from "../worker/index";

describe("hosted local-first reader boundary", () => {
  beforeEach(() => fetchShell.mockClear());
  const env = { ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
  const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

  it.each(["/_vinext/image", "/_next/image"])("does not expose the unused %s processing API", async (endpoint) => {
    const response = await worker.fetch(new Request(`https://reader.example${endpoint}?url=https://elsewhere.example/image.avif&w=640&q=75`), env, context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchShell).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("continues forwarding ordinary shell and asset requests unchanged", async () => {
    for (const pathname of ["/", "/assets/reader.js", "/vendor/pdfjs/pdf.worker.mjs"]) {
      const request = new Request(`https://reader.example${pathname}`);
      const response = await worker.fetch(request, env, context);
      expect(await response.text()).toBe("reader shell");
      expect(fetchShell).toHaveBeenLastCalledWith(request, env, context);
    }
  });
});
