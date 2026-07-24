import { NextRequest } from "next/server";
import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  const cookieStore = cookies();
  const cookieToken = cookieStore.get("access_token")?.value;
  const headerToken = req.headers.get("authorization")?.replace("Bearer ", "");
  const token = cookieToken ?? headerToken;

  const body = await req.json();

  try {
    const res = await fetch(`${API_URL}/api/v1/agent/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status });
  } catch {
    return Response.json({ error: "无法连接到 AI 服务" }, { status: 502 });
  }
}
