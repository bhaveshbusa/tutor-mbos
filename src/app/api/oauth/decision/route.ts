import {
  createSupabaseConsentGateway,
  handleConsentDecision,
} from "@/adapters/http/consent";
import { withAccess } from "@/adapters/http/production";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return withAccess(request, process.env, (deps) =>
    handleConsentDecision(
      request,
      deps,
      createSupabaseConsentGateway(process.env),
    ),
  );
}
