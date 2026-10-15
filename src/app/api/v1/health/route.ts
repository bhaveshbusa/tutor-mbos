import { healthResponse } from "@/adapters/http/v1";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return healthResponse(process.env, {
    commit: process.env.TUTOR_MBOS_BUILD_COMMIT ?? "",
  });
}
