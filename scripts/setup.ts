import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

if (process.argv.includes("--reset-login")) {
  if (!existsSync("data/radar.db")) {
    console.log("Ainda não existe banco de dados. Nada a fazer.");
    process.exit(0);
  }
  const db = new DatabaseSync("data/radar.db");
  db.exec("PRAGMA foreign_keys = ON; DELETE FROM users;");
  db.close();
  console.log("Login apagado. Abra o painel e crie o acesso de novo com o código SETUP_TOKEN do arquivo .env.");
  process.exit(0);
}

if (existsSync(".env")) {
  console.log("O arquivo .env já existe. Nada foi alterado.");
  process.exit(0);
}

copyFileSync(".env.example", ".env");
const content = readFileSync(".env", "utf8")
  .replace("APP_SECRET=", `APP_SECRET=${randomBytes(48).toString("base64url")}`)
  .replace("SETUP_TOKEN=", `SETUP_TOKEN=${randomBytes(18).toString("base64url")}`);
writeFileSync(".env", content);
console.log("Arquivo .env criado com chaves aleatórias.");
console.log("Copie o valor de SETUP_TOKEN do .env: ele será pedido no primeiro acesso ao painel.");
