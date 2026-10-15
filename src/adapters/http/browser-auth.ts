import {
  allowedAppRedirects,
  isAllowedBrowserNext,
} from "@/server/config/access";
import { problemResponse } from "./problem";

export interface BrowserAuth {
  signIn(
    email: string,
    password: string,
  ): Promise<"ok" | "invalid" | "unavailable">;
  recover(email: string, redirectTo: string): Promise<"ok" | "unavailable">;
  exchange(code: string): Promise<"ok" | "invalid" | "unavailable">;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function handleLogin(
  request: Request,
  auth: BrowserAuth,
  siteOrigin: string,
): Promise<Response> {
  if (request.headers.get("origin") !== siteOrigin) {
    return problemResponse(
      403,
      "Forbidden",
      "The browser origin is not allowed.",
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) return problemResponse(400, "Bad request", "invalid_body");
  const result = await auth.signIn(
    field(form, "email"),
    field(form, "password"),
  );
  if (result === "unavailable") {
    return problemResponse(
      503,
      "Authentication unavailable",
      "Sign-in could not be completed.",
    );
  }
  if (result === "invalid") {
    return problemResponse(401, "Unauthorized", "Sign-in failed.");
  }
  const next = field(form, "next");
  const destination = isAllowedBrowserNext(next) ? next : "/onboarding";
  return Response.redirect(new URL(destination, siteOrigin), 303);
}

export async function handleRecovery(
  request: Request,
  auth: BrowserAuth,
  siteOrigin: string,
): Promise<Response> {
  if (request.headers.get("origin") !== siteOrigin) {
    return problemResponse(
      403,
      "Forbidden",
      "The browser origin is not allowed.",
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) return problemResponse(400, "Bad request", "invalid_body");
  const redirectTo =
    allowedAppRedirects(siteOrigin)[0] ?? `${siteOrigin}/auth/callback`;
  const result = await auth.recover(field(form, "email"), redirectTo);
  if (result === "unavailable") {
    return problemResponse(
      503,
      "Authentication unavailable",
      "Account recovery could not be started.",
    );
  }
  return Response.redirect(new URL("/login?recovery=sent", siteOrigin), 303);
}

export async function handleCallback(
  request: Request,
  auth: BrowserAuth,
  siteOrigin: string,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/business";
  if (!code) return problemResponse(400, "Bad request", "missing_code");
  const result = await auth.exchange(code);
  if (result === "unavailable") {
    return problemResponse(
      503,
      "Authentication unavailable",
      "The session could not be created.",
    );
  }
  if (result === "invalid")
    return problemResponse(
      401,
      "Unauthorized",
      "The sign-in code was rejected.",
    );
  const destination = isAllowedBrowserNext(next) ? next : "/business";
  return Response.redirect(new URL(destination, siteOrigin), 303);
}
