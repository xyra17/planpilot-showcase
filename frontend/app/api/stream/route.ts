import { NextRequest } from "next/server";
import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  const cookieStore = cookies();
  const cookieToken = cookieStore.get("access_token")?.value;
  const headerToken = req.headers.get("authorization")?.replace("Bearer ", "");
  const token = cookieToken ?? headerToken;

  const body = await req.json();

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/api/v1/agent/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return new Response(
      `event: error\ndata: {"message":"无法连接到 AI 服务，请确认后端已启动"}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  if (!upstream.ok) {
    return new Response(
      `event: error\ndata: {"message":"服务异常 (${upstream.status})"}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
