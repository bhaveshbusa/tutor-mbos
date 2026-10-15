import { createAccessHandlers } from "@/adapters/http/access";
import { withAccess } from "@/adapters/http/production";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return withAccess(request, process.env, (deps) =>
    createAccessHandlers(deps).getBusiness(request),
  );
}

export function POST(request: Request): Promise<Response> {
  return withAccess(request, process.env, async (deps) => {
    const response = await createAccessHandlers(deps).postBusiness(request);
    const type = request.headers.get("content-type") ?? "";
    if (
      type.includes("application/x-www-form-urlencoded") &&
      response.status < 400
    ) {
      return Response.redirect(new URL("/business", request.url), 303);
    }
    return response;
  });
}
