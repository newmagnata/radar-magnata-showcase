import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT NOT NULL,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    last_totp_step INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    totp_ok INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    keywords TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    jid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    auto INTEGER NOT NULL DEFAULT 1,
    approval INTEGER NOT NULL DEFAULT 0,
    window_start TEXT,
    window_end TEXT,
    next_send_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    item_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    image_url TEXT NOT NULL,
    product_link TEXT NOT NULL,
    price REAL NOT NULL,
    discount_rate REAL NOT NULL,
    commission_rate REAL NOT NULL,
    rating REAL NOT NULL,
    sales INTEGER NOT NULL,
    shop_name TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE offers (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    origin TEXT NOT NULL CHECK (origin IN ('auto','manual')),
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN
      ('draft','pending_approval','queued','sending','sent','failed','rejected','expired','canceled')),
    text TEXT NOT NULL DEFAULT '',
    short_link TEXT NOT NULL DEFAULT '',
    approval_notified INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX offers_status ON offers(status, priority DESC, id);
  CREATE INDEX offers_repeat ON offers(group_id, product_id, created_at);
  CREATE TABLE group_events (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    participant_hash TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add','remove')),
    ts INTEGER NOT NULL
  );
  CREATE INDEX group_events_ts ON group_events(ts);
  CREATE TABLE conversions (
    key TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','validated','canceled')),
    gmv REAL NOT NULL,
    commission REAL NOT NULL,
    purchase_time INTEGER NOT NULL,
    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    origin TEXT,
    offer_id INTEGER,
    raw_sub TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX conversions_time ON conversions(purchase_time);
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE coupons (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
    value REAL NOT NULL,
    min_price REAL NOT NULL DEFAULT 0,
    max_discount REAL NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    expires_on TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE offers ADD COLUMN coupon_id INTEGER REFERENCES coupons(id);
  `,
  `
  CREATE TABLE group_categories (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, category_id)
  );
  INSERT INTO group_categories (group_id, category_id) SELECT id, category_id FROM groups WHERE category_id IS NOT NULL;
  ALTER TABLE groups ADD COLUMN min_commission_value REAL NOT NULL DEFAULT 0;
  ALTER TABLE groups ADD COLUMN min_commission_rate REAL NOT NULL DEFAULT 0;
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

const CATEGORIES: [string, string, string[]][] = [
  ["Casa e Decoração", "casa", ["decoração casa", "organizador casa"]],
  ["Cozinha e Utensílios", "cozinha", ["utensílios cozinha", "panela", "air fryer acessórios"]],
  ["Eletrodomésticos", "eletrodomesticos", ["eletrodoméstico", "liquidificador"]],
  ["Celulares e Acessórios", "celulares", ["capinha celular", "carregador turbo"]],
  ["Eletrônicos", "eletronicos", ["eletrônicos", "smartwatch"]],
  ["Informática", "informatica", ["mouse sem fio", "teclado"]],
  ["Áudio e Fones", "audio", ["fone bluetooth", "caixa de som"]],
  ["Games", "games", ["controle gamer", "headset gamer"]],
  ["Moda Feminina", "modafeminina", ["vestido feminino", "blusa feminina"]],
  ["Moda Masculina", "modamasculina", ["camiseta masculina", "bermuda masculina"]],
  ["Calçados", "calcados", ["tênis", "sandália"]],
  ["Bolsas e Acessórios", "bolsas", ["bolsa feminina", "mochila"]],
  ["Relógios", "relogios", ["relógio masculino", "relógio feminino"]],
  ["Beleza e Cuidados Pessoais", "beleza", ["skincare", "maquiagem"]],
  ["Perfumes", "perfumes", ["perfume importado", "perfume masculino"]],
  ["Saúde e Suplementos", "suplementos", ["whey protein", "creatina", "suplemento"]],
  ["Esportes e Fitness", "esportes", ["academia acessórios", "garrafa térmica"]],
  ["Mãe e Bebê", "bebe", ["bebê enxoval", "fralda"]],
  ["Brinquedos", "brinquedos", ["brinquedo educativo", "boneca"]],
  ["Pets", "pets", ["ração pet", "brinquedo cachorro"]],
  ["Automotivo", "automotivo", ["acessórios carro", "suporte veicular"]],
  ["Ferramentas e Construção", "ferramentas", ["parafusadeira", "kit ferramentas"]],
  ["Papelaria e Escritório", "papelaria", ["caderno", "material escolar"]],
  ["Alimentos e Bebidas", "alimentos", ["café especial", "chocolate"]],
];

export function seedCategories(db: Db): void {
  const insert = db.prepare("INSERT OR IGNORE INTO categories (name, code, keywords) VALUES (?, ?, ?)");
  for (const [name, code, keywords] of CATEGORIES) insert.run(name, code, JSON.stringify(keywords));
}

export function log(db: Db, level: "info" | "warn" | "error", message: string, ts = Date.now()): void {
  db.prepare("INSERT INTO logs (ts, level, message) VALUES (?, ?, ?)").run(ts, level, message.slice(0, 500));
}
