export const API_VERSION = "v1";

const NO_STORE = "no-store";

export function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": NO_STORE },
  });
}

/** RFC 9457 problem details response. */
export function problemResponse(
  status: number,
  title: string,
  detail: string,
): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", status, title, detail }),
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": NO_STORE,
      },
    },
  );
}
