import { z } from "zod";
import type { Db } from "./db.ts";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:MM");

export const rateSchema = z
  .object({
    maxPerMinute: z.number().int().min(1).max(4),
    groupIntervalMin: z.number().min(1).max(720),
    groupIntervalMax: z.number().min(1).max(720),
    maxPerDay: z.number().int().min(1).max(200),
    jitterMin: z.number().min(0).max(600),
    jitterMax: z.number().min(0).max(600),
    repeatDays: z.number().min(0.04).max(30),
  })
  .refine((r) => r.groupIntervalMin <= r.groupIntervalMax && r.jitterMin <= r.jitterMax, {
    message: "O valor mínimo não pode ser maior que o máximo",
  });

export type Rate = z.output<typeof rateSchema>;

export const PRESETS = {
  conservador: { maxPerMinute: 1, groupIntervalMin: 25, groupIntervalMax: 35, maxPerDay: 20, jitterMin: 30, jitterMax: 120, repeatDays: 3 },
  moderado: { maxPerMinute: 1, groupIntervalMin: 15, groupIntervalMax: 20, maxPerDay: 35, jitterMin: 20, jitterMax: 90, repeatDays: 2 },
  acelerado: { maxPerMinute: 2, groupIntervalMin: 8, groupIntervalMax: 12, maxPerDay: 60, jitterMin: 10, jitterMax: 60, repeatDays: 1 },
} satisfies Record<string, Rate>;

export const DEFAULT_LAYOUT = "*{chamada}*\n\n*{titulo}*\n\n{preco_antigo}\n💸 por *R$ {preco}*\n{cupom}\n\n{loja_oficial}\nCompre aqui: {link}";

/** Completa com o DDI do Brasil quando o número vem só com DDD. */
export function fullNumber(raw: string): string {
  return raw.length === 10 || raw.length === 11 ? `55${raw}` : raw;
}

export const settingsSchema = z
  .object({
    autoMode: z.boolean(),
    useAi: z.boolean(),
    preset: z.enum(["conservador", "moderado", "acelerado", "personalizado"]),
    custom: rateSchema,
    windowStart: time,
    windowEnd: time,
    approverNumber: z
      .string()
      .regex(/^\d{0,15}$/, "Só números, com DDD")
      .transform(fullNumber)
      .refine((v) => v === "" || v.length >= 12, "Número incompleto: informe o DDD e o número"),
    layout: z
      .string()
      .min(10)
      .max(1000)
      .refine((v) => v.includes("{link}"), "O layout precisa ter {link}, senão a oferta não gera comissão"),
    minRating: z.number().min(0).max(5),
    minDiscount: z.number().min(0).max(95),
    minPrice: z.number().min(0),
    maxPrice: z.number().min(0),
  })
  .strict();

export type Settings = z.output<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  autoMode: false,
  useAi: true,
  preset: "conservador",
  custom: PRESETS.conservador,
  windowStart: "08:00",
  windowEnd: "20:30",
  approverNumber: "",
  layout: DEFAULT_LAYOUT,
  minRating: 4.5,
  minDiscount: 10,
  minPrice: 0,
  maxPrice: 0,
};

export function getSettings(db: Db): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_SETTINGS;
  const saved = { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<Settings>) };
  return { ...saved, approverNumber: fullNumber(saved.approverNumber) };
}

export function saveSettings(db: Db, value: Settings): void {
  db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(value),
  );
}

export function activeRate(s: Settings): Rate {
  return s.preset === "personalizado" ? s.custom : PRESETS[s.preset];
}

const clockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function saoPauloClock(ms: number): string {
  return clockFormat.format(ms);
}

/** Início do dia atual em São Paulo (UTC-3, sem horário de verão). */
export function saoPauloDayStart(ms: number): number {
  const offset = 3 * 3_600_000;
  return Math.floor((ms - offset) / 86_400_000) * 86_400_000 + offset;
}

export function insideWindow(clock: string, start: string, end: string): boolean {
  return start <= end ? clock >= start && clock < end : clock >= start || clock < end;
}
