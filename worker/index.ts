/** Hosted shell/assets only; PDFs and camera frames stay in the client. */
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // No reader feature uses server image processing. Explicitly close both
    // template/compatibility endpoints instead of exposing a remote optimizer.
    if (url.pathname === "/_vinext/image" || url.pathname === "/_next/image") {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
