import { jwtDecode } from "jwt-decode";

const TOKEN_KEY = "sb_token";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  schoolRole: string;
  schoolId: number;
  schoolName: string;
  schoolCode: string;
  onboarded: boolean;
  // Computed server-side at sign-in (email compared against OWNER_EMAIL there) —
  // never derive this from a client env var, since anything in import.meta.env
  // ends up readable in the compiled JS bundle.
  isOwner: boolean;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  subscriptionEndsAt: string | null;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem("sb_user");
}

export function setUser(user: AuthUser): void {
  localStorage.setItem("sb_user", JSON.stringify(user));
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem("sb_user");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function isTokenValid(): boolean {
  const token = getToken();
  if (!token) return false;
  try {
    const decoded = jwtDecode<{ exp: number }>(token);
    return decoded.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function getTrialDaysRemaining(): number | null {
  const user = getUser();
  if (!user?.trialEndsAt || user.subscriptionStatus !== "trial") return null;
  const diff = new Date(user.trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
