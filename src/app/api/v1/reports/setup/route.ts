import { createAccessHandlers } from "@/adapters/http/access";
import { withAccess } from "@/adapters/http/production";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return withAccess(request, process.env, (deps) =>
    createAccessHandlers(deps).setupReport(request),
  );
}
