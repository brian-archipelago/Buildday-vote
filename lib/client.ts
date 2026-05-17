"use client";

const ADMIN_KEY = "hv_admin_token";
const VOTER_KEY = "hv_voter_id";

export function getAdminToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ADMIN_KEY) || "";
}
export function setAdminToken(v: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ADMIN_KEY, v);
}
export function clearAdminToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ADMIN_KEY);
}

export function getVoterId(): string {
  if (typeof window === "undefined") return "";
  let v = window.localStorage.getItem(VOTER_KEY);
  if (!v) {
    v = `v_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    window.localStorage.setItem(VOTER_KEY, v);
  }
  return v;
}

export async function adminFetch(url: string, init: RequestInit = {}) {
  const token = getAdminToken();
  const headers = new Headers(init.headers || {});
  headers.set("x-admin-token", token);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json().catch(() => ({}));
}
