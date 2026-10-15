import { createMcpHandler } from "@/adapters/mcp/handler";
import { withAccess } from "@/adapters/http/production";

export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return withAccess(request, process.env, (deps) =>
    createMcpHandler(deps)(request),
  );
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
