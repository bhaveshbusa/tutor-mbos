import { openApiResponse } from "@/adapters/http/openapi";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return openApiResponse(process.env);
}
