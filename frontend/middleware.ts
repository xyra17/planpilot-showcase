import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Authorization is verified by AuthBoundary against /auth/me. A middleware
  // cookie-presence check would incorrectly reject valid refresh sessions
  // whenever the 15-minute access cookie expires.
  void request;
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
