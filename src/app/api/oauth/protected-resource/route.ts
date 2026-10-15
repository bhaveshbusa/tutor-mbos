import { protectedResourceResponse } from "@/adapters/http/discovery";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return protectedResourceResponse(process.env);
}
