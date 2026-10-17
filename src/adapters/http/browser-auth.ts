import {
  browserRequestAllowed,
  isAllowedBrowserNext,
  recoveryRedirect,
} from "@/server/config/access";
import { problemResponse } from "./problem";

export interface BrowserAuth {
  signIn(
    email: string,
    password: string,
  ): Promise<"ok" | "invalid" | "unavailable">;
  recover(email: string, redirectTo: string): Promise<"ok" | "unavailable">;
  exchange(code: string): Promise<"ok" | "invalid" | "unavailable">;
  updatePassword(password: string): Promise<"ok" | "invalid" | "unavailable">;
}

export function acceptablePassword(value: string): boolean {
  if (value.length < 8 || value.length > 72) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
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
  if (!browserRequestAllowed(request, siteOrigin)) {
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
  if (!browserRequestAllowed(request, siteOrigin)) {
    return problemResponse(
      403,
      "Forbidden",
      "The browser origin is not allowed.",
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) return problemResponse(400, "Bad request", "invalid_body");
  const redirectTo = recoveryRedirect(siteOrigin);
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
  const next =
    url.searchParams.get("type") === "recovery"
      ? "/auth/update-password"
      : (url.searchParams.get("next") ?? "/business");
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

export async function handlePasswordUpdate(
  request: Request,
  auth: BrowserAuth,
  siteOrigin: string,
): Promise<Response> {
  if (!browserRequestAllowed(request, siteOrigin)) {
    return problemResponse(
      403,
      "Forbidden",
      "The browser origin is not allowed.",
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) return problemResponse(400, "Bad request", "invalid_body");
  const password = field(form, "password");
  if (!acceptablePassword(password)) {
    return problemResponse(400, "Bad request", "invalid_password");
  }
  const result = await auth.updatePassword(password);
  if (result === "unavailable") {
    return problemResponse(
      503,
      "Authentication unavailable",
      "The password could not be updated.",
    );
  }
  if (result === "invalid") {
    return problemResponse(
      401,
      "Unauthorized",
      "A recovery session is required.",
    );
  }
  return Response.redirect(new URL("/business", siteOrigin), 303);
}

export async function handleRecoveryCallback(
  request: Request,
  auth: BrowserAuth,
  siteOrigin: string,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return Response.redirect(new URL("/auth/update-password", siteOrigin), 303);
  }
  const result = await auth.exchange(code);
  if (result === "unavailable") {
    return problemResponse(
      503,
      "Authentication unavailable",
      "The recovery session could not be created.",
    );
  }
  if (result === "invalid") {
    return problemResponse(
      401,
      "Unauthorized",
      "The recovery code was rejected.",
    );
  }
  return Response.redirect(new URL("/auth/update-password", siteOrigin), 303);
}
