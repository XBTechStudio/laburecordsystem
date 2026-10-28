import { NextResponse, type NextRequest } from "next/server";

// Cheap gate: no session cookie → login page. The session itself is checked against the database in each page.
export function proxy(req: NextRequest) {
  if (!req.cookies.has("xb_sess")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|_next|favicon.ico|api/health).*)"],
};
