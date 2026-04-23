import { NextRequest } from "next/server";

export function requireAdmin(req: NextRequest): Response | null {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    // If no admin token is configured, fail closed.
    return new Response(JSON.stringify({ error: "Admin token not configured on server" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const header = req.headers.get("x-admin-token");
  if (header !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}
