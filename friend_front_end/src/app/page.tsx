import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { hasValidSessionCookie } from "@/lib/auth/cookie";
import { SESSION_COOKIE } from "@/types/session";

export default async function HomePage() {
  const cookieStore = await cookies();
  const hasAuth = hasValidSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  redirect(hasAuth ? "/desk" : "/login");
}
