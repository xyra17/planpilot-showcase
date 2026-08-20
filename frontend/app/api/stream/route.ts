import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

/** Compatibility proxy for the legacy goal chat; it forwards the same
 * HttpOnly-cookie and CSRF contract used by direct API calls. */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const cookie = req.headers.get("cookie");
  const csrf = req.headers.get("x-csrf-token");
  try {
    const upstream = await fetch(`${API_URL}/api/v1/agent/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body,
      cache: "no-store",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return NextResponse.json({ detail: "无法连接到 AI 服务" }, { status: 502 });
  }
}
