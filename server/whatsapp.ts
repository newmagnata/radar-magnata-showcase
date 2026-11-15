import { join } from "node:path";
import { rmSync } from "node:fs";
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from "baileys";
import pino from "pino";
import QRCode from "qrcode";

export interface WhatsAppStatus {
  state: "disconnected" | "connecting" | "qr" | "open";
  qr?: string;
  detail?: string;
}

export interface WaGroup {
  jid: string;
  name: string;
  size: number;
}

export interface GroupEvent {
  groupJid: string;
  participants: string[];
  action: "add" | "remove";
}

export interface InboundMessage {
  from: string;
  text: string;
}

export interface WhatsAppProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): WhatsAppStatus;
  sendImage(jid: string, imageUrl: string, caption: string): Promise<void>;
  sendText(jid: string, text: string): Promise<void>;
  listGroups(): Promise<WaGroup[]>;
  onGroupEvent(handler: (event: GroupEvent) => void): void;
  onMessage(handler: (message: InboundMessage) => void): void;
}

type Socket = ReturnType<typeof makeWASocket>;

/** Conexão direta para rodar sem Docker: usa a sessão salva em data/wa-auth. */
export class BaileysProvider implements WhatsAppProvider {
  private readonly dir: string;
  private socket: Socket | null = null;
  private starting: Promise<void> | null = null;
  private current: WhatsAppStatus = { state: "disconnected" };
  private groupHandler: (event: GroupEvent) => void = () => {};
  private messageHandler: (message: InboundMessage) => void = () => {};
  private retries = 0;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "wa-auth");
  }

  status(): WhatsAppStatus {
    return this.current;
  }

  onGroupEvent(handler: (event: GroupEvent) => void): void {
    this.groupHandler = handler;
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  start(): Promise<void> {
    this.stopped = false;
    if (this.socket) return Promise.resolve();
    this.starting ??= this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private retry(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.start().catch((error: Error) => {
        this.retries += 1;
        this.current = { state: "connecting", detail: `Falha ao reconectar: ${error.message}` };
        this.retry(Math.min(300_000, 3000 * 2 ** this.retries));
      });
    }, delay);
  }

  private async open(): Promise<void> {
    this.current = { state: "connecting" };
    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }),
      browser: Browsers.windows("Radar Magnata"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.socket = socket;

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", (update) => {
      if (update.qr) {
        void QRCode.toDataURL(update.qr, { margin: 1, width: 320 }).then((qr) => {
          if (this.current.state !== "open") this.current = { state: "qr", qr };
        });
      }
      if (update.connection === "open") {
        this.retries = 0;
        this.current = { state: "open" };
      }
      if (update.connection === "close") {
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.socket = null;
        if (code === DisconnectReason.loggedOut) {
          rmSync(this.dir, { recursive: true, force: true });
          this.current = { state: "disconnected", detail: "O WhatsApp encerrou esta conexão. Conecte de novo pelo QR Code." };
          return;
        }
        if (this.stopped) {
          this.current = { state: "disconnected" };
          return;
        }
        if (code === DisconnectReason.timedOut && !state.creds.me) {
          this.current = { state: "disconnected", detail: "O QR Code expirou. Clique em Conectar para gerar outro." };
          return;
        }
        this.retries += 1;
        const delay = Math.min(300_000, 3000 * 2 ** this.retries);
        this.current = { state: "connecting", detail: `Reconectando (tentativa ${this.retries})` };
        this.retry(delay);
      }
    });
    socket.ev.on("group-participants.update", (event) => {
      if (event.action !== "add" && event.action !== "remove") return;
      this.groupHandler({
        groupJid: event.id,
        action: event.action,
        participants: event.participants.map((p) => (typeof p === "string" ? p : p.id)),
      });
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        const key = message.key;
        if (key.fromMe || !key.remoteJid || key.remoteJid.endsWith("@g.us")) continue;
        const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
        const from = key.remoteJidAlt ?? key.remoteJid;
        if (text) this.messageHandler({ from, text });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.end(undefined);
    this.socket = null;
    this.current = { state: "disconnected" };
  }

  private connected(): Socket {
    if (!this.socket || this.current.state !== "open") throw new Error("WhatsApp não conectado");
    return this.socket;
  }

  /** Descobre o endereço real do contato: contas antigas do Brasil não têm o nono dígito. */
  private async resolve(jid: string): Promise<string> {
    if (jid.endsWith("@g.us") || jid.endsWith("@lid")) return jid;
    const [found] = (await this.connected().onWhatsApp(jid)) ?? [];
    if (!found?.exists) throw new Error("Este número não está no WhatsApp");
    return found.jid;
  }

  async sendImage(jid: string, imageUrl: string, caption: string): Promise<void> {
    await this.connected().sendMessage(await this.resolve(jid), { image: { url: imageUrl }, caption });
  }

  async sendText(jid: string, text: string): Promise<void> {
    await this.connected().sendMessage(await this.resolve(jid), { text });
  }

  async listGroups(): Promise<WaGroup[]> {
    const groups = await this.connected().groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ jid: g.id, name: g.subject, size: g.size ?? g.participants.length }));
  }
}

interface EvolutionOptions {
  url: string;
  apiKey: string;
  instance: string;
}

/** Conector para a fase da VPS, com a Evolution API rodando em Docker. */
export class EvolutionProvider implements WhatsAppProvider {
  private readonly options: EvolutionOptions;
  private current: WhatsAppStatus = { state: "disconnected" };
  private groupHandler: (event: GroupEvent) => void = () => {};
  private messageHandler: (message: InboundMessage) => void = () => {};
  private timer: NodeJS.Timeout | undefined;

  constructor(options: EvolutionOptions) {
    this.options = options;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.options.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { apikey: this.options.apiKey, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Evolution API respondeu HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private path(prefix: string): string {
    return `${prefix}/${encodeURIComponent(this.options.instance)}`;
  }

  status(): WhatsAppStatus {
    return this.current;
  }

  onGroupEvent(handler: (event: GroupEvent) => void): void {
    this.groupHandler = handler;
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler;
  }

  async refresh(): Promise<void> {
    try {
      const { instance } = await this.call<{ instance: { state: string } }>("GET", this.path("/instance/connectionState"));
      if (instance.state === "open") {
        this.current = { state: "open" };
        return;
      }
      const connect = await this.call<{ base64?: string }>("GET", this.path("/instance/connect"));
      this.current = connect.base64 ? { state: "qr", qr: connect.base64 } : { state: "connecting" };
    } catch (error) {
      this.current = { state: "disconnected", detail: error instanceof Error ? error.message : "Falha na Evolution API" };
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), 15_000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sendImage(jid: string, imageUrl: string, caption: string): Promise<void> {
    await this.call("POST", this.path("/message/sendMedia"), { number: jid, mediatype: "image", media: imageUrl, caption });
  }

  async sendText(jid: string, text: string): Promise<void> {
    await this.call("POST", this.path("/message/sendText"), { number: jid, text });
  }

  async listGroups(): Promise<WaGroup[]> {
    const groups = await this.call<{ id: string; subject: string; size?: number }[]>(
      "GET",
      `${this.path("/group/fetchAllGroups")}?getParticipants=false`,
    );
    return groups.map((g) => ({ jid: g.id, name: g.subject, size: g.size ?? 0 }));
  }

  /** Recebe os eventos enviados pelo webhook da Evolution API. */
  handleWebhook(payload: { event?: string; data?: Record<string, unknown> }): void {
    const event = payload.event?.toLowerCase().replaceAll("_", "-").replaceAll(".", "-");
    const data = payload.data ?? {};
    if (event === "group-participants-update" && (data.action === "add" || data.action === "remove")) {
      this.groupHandler({
        groupJid: String(data.id),
        action: data.action,
        participants: (data.participants as unknown[]).map((p) => (typeof p === "string" ? p : String((p as { id: string }).id))),
      });
    }
    if (event === "messages-upsert") {
      const key = data.key as { remoteJid?: string; remoteJidAlt?: string; fromMe?: boolean } | undefined;
      const message = data.message as { conversation?: string; extendedTextMessage?: { text?: string } } | undefined;
      const text = message?.conversation ?? message?.extendedTextMessage?.text;
      if (key?.remoteJid && !key.fromMe && !key.remoteJid.endsWith("@g.us") && text) {
        this.messageHandler({ from: key.remoteJidAlt ?? key.remoteJid, text });
      }
    }
  }
}
