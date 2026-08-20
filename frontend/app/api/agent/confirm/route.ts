import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

/** Cookie-authenticated compatibility proxy. New clients call the API
 * directly through the shared api client. */
export async function POST(req: NextRequest) {
  const cookie = req.headers.get("cookie");
  const csrf = req.headers.get("x-csrf-token");
  try {
    const upstream = await fetch(`${API_URL}/api/v1/agent/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: await req.text(),
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ detail: "无法连接到 AI 服务" }, { status: 502 });
  }
}
