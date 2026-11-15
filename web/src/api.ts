import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("radar:logout"));
    throw new ApiError(response.status, payload.error ?? "Não foi possível concluir a operação");
  }
  return payload as T;
}

export function useLoad<T>(path: string, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const result = await api<T>(path);
      if (request !== latest.current) return;
      setData(result);
      setError("");
    } catch (reason) {
      if (request === latest.current) setError((reason as Error).message);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
  }, [reload, pollMs]);

  return { data, error, loading, reload };
}

export const brl = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const number = (value: number) => value.toLocaleString("pt-BR");
export const commissionOf = (price: number, ratePercent: number) => (price * ratePercent) / 100;
export const dateTime = (ms: number) =>
  new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export interface Rate {
  maxPerMinute: number;
  groupIntervalMin: number;
  groupIntervalMax: number;
  maxPerDay: number;
  jitterMin: number;
  jitterMax: number;
  repeatDays: number;
}

export interface Settings {
  autoMode: boolean;
  useAi: boolean;
  preset: "conservador" | "moderado" | "acelerado" | "personalizado";
  custom: Rate;
  windowStart: string;
  windowEnd: string;
  approverNumber: string;
  layout: string;
  minRating: number;
  minDiscount: number;
  minPrice: number;
  maxPrice: number;
}

export interface WhatsAppStatus {
  state: "disconnected" | "connecting" | "qr" | "open";
  qr?: string;
  detail?: string;
}

export interface AppStatus {
  whatsapp: WhatsAppStatus;
  shopee: boolean;
  ai: boolean;
  settings: Settings;
  rate: Rate;
  queue: { status: string; n: number }[];
}

export interface Category {
  id: number;
  name: string;
  code: string;
  keywords: string[];
  active: number;
}

export interface IntegrationField {
  key: string;
  label: string;
  secret: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  configured: boolean;
  value: string | null;
  ending: string | null;
  source: "painel" | "arquivo" | null;
}

export interface IntegrationSection {
  id: string;
  name: string;
  help: string;
  testable: boolean;
  fields: IntegrationField[];
}

export interface Coupon {
  id: number;
  code: string;
  kind: "percent" | "fixed";
  value: number;
  min_price: number;
  max_discount: number;
  category_id: number | null;
  expires_on: string | null;
  active: number;
}

export interface Group {
  id: number;
  jid: string;
  name: string;
  code: string;
  category_ids: number[];
  min_commission_value: number;
  min_commission_rate: number;
  automation: { running: boolean; reason: string };
  active: number;
  auto: number;
  approval: number;
  window_start: string | null;
  window_end: string | null;
}

export interface Offer {
  id: number;
  status: string;
  origin: string;
  priority: number;
  text: string;
  error: string | null;
  created_at: number;
  sent_at: number | null;
  product: string;
  image_url: string;
  price: number;
  commission_rate: number;
  group_name: string;
}

export interface Product {
  itemId: string;
  name: string;
  imageUrl: string;
  price: number;
  discountRate: number;
  commissionRate: number;
  rating: number;
  sales: number;
  shopName: string;
}

export interface MetricRow {
  name: string;
  commission: number;
  gmv: number;
  orders: number;
}

export interface Dashboard {
  totals: { commission: number; validated: number; pending: number; gmv: number; orders: number };
  daily: { day: string; commission: number; gmv: number; orders: number }[];
  monthly: { month: string; commission: number; gmv: number; orders: number }[];
  byGroup: MetricRow[];
  byCategory: MetricRow[];
  byProduct: MetricRow[];
  origin: MetricRow[];
  leads: { daily: { day: string; joined: number; left_group: number }[]; joined: number; left: number };
}
