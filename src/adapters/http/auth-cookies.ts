export function serializeAuthCookie(
  name: string,
  value: string,
  options: {
    path?: string;
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: boolean | "none" | "strict" | "lax";
  },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (typeof options.maxAge === "number")
    parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

export function applySetCookies(
  response: Response,
  setCookies: readonly string[],
): Response {
  if (setCookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}
