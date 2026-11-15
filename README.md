# Radar Magnata (amostra)

Sistema que garimpa ofertas da Shopee e as envia para grupos de WhatsApp com imagem, texto escrito por IA, cupom e link de afiliado. Controla o ritmo de envio para reduzir risco de banimento e mostra comissão e vendas por grupo, categoria e produto.

> Versão de demonstração para portfólio, sem histórico, sem chaves e sem dados reais.

## Recursos
- Busca de ofertas pela Open API de afiliados da Shopee
- Fila de envio com ritmo configurável (modos conservador, normal e rápido) e deduplicação
- Envio automático por grupo e envio manual com prioridade
- Aprovação das ofertas pelo painel ou pelo WhatsApp
- Texto das ofertas gerado por IA (Anthropic ou NVIDIA), com frases padrão como alternativa
- Cupons, integrações configuráveis pela tela (credenciais cifradas)
- Dashboard de comissão e valor vendido por dia, mês, grupo, categoria e produto, via sub IDs
- Login com 2FA e cadastro protegido por token (estrutura pronta, desligada por padrão em uso local)

## Tecnologias
Node.js 24 · TypeScript · Fastify · React + Vite · SQLite · Baileys / Evolution API (WhatsApp) · Argon2 e TOTP · Vitest

## Como rodar
```bash
npm install
npm run setup   # gera APP_SECRET e SETUP_TOKEN no .env
npm run build
npm start
```
Copie `.env.example` para `.env` e preencha as suas credenciais (Shopee, IA, WhatsApp). Os testes rodam com `npm test`.

## Documentação
A especificação completa (fases, arquitetura, anti-ban e métricas) está em [`docs/ESPECIFICACAO.md`](docs/ESPECIFICACAO.md).

## Segurança
Nenhuma credencial é versionada. Chaves ficam no `.env` (ignorado pelo Git) ou cifradas no banco local.
