# Radar Magnata — Especificação do Projeto

> Status: **planejamento** (nenhum código escrito ainda).
> Última atualização: 05/11/2026.
> Regra combinada: só começar a programar quando o dono do projeto disser **"ok"**.

---

## 1. Visão geral

O Radar Magnata é um buscador automático de ofertas de marketplace (Shopee primeiro, depois Mercado Livre e Amazon). Ele envia as ofertas para grupos de WhatsApp com link de afiliado, cupom aplicado, imagem e texto escrito por IA, e mede o faturamento num dashboard.

- **Uso atual:** pessoal (1 operador).
- **Futuro possível:** vender como SaaS para outros afiliados. A arquitetura já nasce preparada para isso (separação por "conta"), mas sem login multi-cliente no MVP.

### Situação atual do operador
| Item | Situação |
|---|---|
| Afiliado Shopee | ✅ aprovado |
| Afiliado Mercado Livre | ❌ ainda não (planejado) |
| Afiliado Amazon | ❌ ainda não (planejado) |
| Grupos de WhatsApp | 1 grupo |
| Chip dedicado | ✅ 1 número |
| Janela de envio | 08:00 às 20:00/21:00 |
| IA | Claude (precisa de **chave da API da Anthropic**, cobrada à parte da assinatura) |

---

## 2. Decisões já tomadas

1. **Ambiente:** primeiro **local** (testes). Depois **VPS** 24h e **domínio** (juntos ou um de cada vez).
2. **WhatsApp:** começar com API **não oficial** (**Evolution API**, baseada em Baileys, em Docker). O envio fica atrás de uma **interface de provedor**, para poder trocar pela API oficial (Meta Cloud API) depois sem refazer o sistema.
   - A API oficial **não serve para grupos de ofertas**: grupos limitados a 8 participantes e cobrança por destinatário (~US$0,0625 por msg de marketing no Brasil em 2026). Uso futuro possível: só uma lista VIP no privado.
3. **Mensagem:** **imagem do produto + texto**. Texto gerado por IA (variado a cada envio) ou montado num layout fixo configurável.
4. **Modos de envio:**
   - **Automático:** o robô garimpa e envia sozinho.
   - **Manual:** o operador escolhe o produto no painel. Por padrão entra como **prioridade** na fila. Existe também a opção **"furar a fila"** (envio imediato, com aviso de risco).
5. **Aprovação** (opcional, ligável por grupo):
   - pelo **painel**;
   - pelo **WhatsApp pessoal** do operador: o robô manda uma prévia e o operador responde `ok` / `não` (ou `1` / `2`).
6. **Faturamento:** mostrar **comissão** (em destaque) **e** **valor vendido (GMV)**, separando comissão **pendente** de **validada**.
7. **Painel:** acesso por **computador e celular** (responsivo), login com **e-mail + senha + verificação em 2 etapas (2FA por app autenticador, TOTP)**.
8. **Ritmo:** começa **conservador**, com presets editáveis pelo painel (ver seção 5).
9. **Categorias:** já vêm cadastradas as mais procuradas da Shopee (seção 6). O operador ativa e vincula aos grupos quando quiser.

---

## 3. Arquitetura

```
[Coletores]  →  [Enriquecedor]  →  [Redator IA]  →  [Aprovação?]  →  [Fila anti-ban]  →  [Provedor WhatsApp]
Shopee API      cupom, preço        texto único      painel/WhatsApp    ritmo, janela,       Evolution API
(ML/Amazon      final, filtros                                          sem repetição        (futuro: oficial)
 via extensão)
                                [Painel + Dashboard]      [Coletor de métricas]
                                config, envio manual       conversões Shopee (sub IDs)
                                faturamento, leads         entradas/saídas dos grupos
```

### Stack proposta
- **Back-end:** Node.js + TypeScript
- **Banco:** PostgreSQL
- **Fila / agendamento:** Redis + BullMQ
- **WhatsApp:** Evolution API (Docker)
- **Painel:** Next.js (responsivo, design profissional)
- **IA:** API da Anthropic (modelo pequeno/barato para mensagens; conferir preço atual antes)
- **Tudo em Docker Compose:** o que roda no PC sobe igual na VPS.

### Módulos
1. **Coletor Shopee:** Shopee Affiliate Open API (GraphQL). Busca ofertas por categoria, mais vendidos, maior comissão e relâmpago, e gera o link de afiliado com sub IDs.
2. **Enriquecedor:** regras de cupom (valor mínimo, teto de desconto, onde vale, validade), cálculo do preço final, filtros (nota mínima, desconto mínimo, faixa de preço).
3. **Redator IA:** gera o texto. Fallback para layout fixo se a IA falhar.
4. **Fila anti-ban:** ver seção 5.
5. **Provedor WhatsApp:** interface única `enviarOferta()`, com a Evolution API como primeira implementação.
6. **Métricas:** importa o relatório de conversões da Shopee e registra eventos de entrada/saída nos grupos.
7. **Painel/Dashboard:** configuração, fila, envio manual, aprovação, relatórios.

---

## 4. Rastreio e dashboard

### Sub IDs (a Shopee aceita até 5 por link)
| sub_id | Exemplo | Significado |
|---|---|---|
| 1 | `grp-casa01` | grupo |
| 2 | `cat-casa` | categoria |
| 3 | `auto` / `manual` | origem do envio |
| 4 | `20261105` | data / campanha |
| 5 | id da oferta | envio exato |

### Métricas do dashboard
- Comissão (pendente / validada) e GMV, **por dia e por mês**
- Por **grupo**, por **categoria**, por **produto**, **automático x manual**
- Nº de pedidos / compras
- **Leads:** entradas, saídas e saldo por grupo e por dia (eventos da Evolution API), incluindo saídas logo após um envio (sinal de oferta ruim ou excesso de envio)
- Ranking: melhores produtos, categorias e horários
- **Cliques:** só na fase VPS + domínio (ver seção 8)

Observação: os pedidos chegam ao relatório da Shopee com algumas horas de atraso, e a comissão só é validada semanas depois.

---

## 5. Ritmo e anti-ban (presets editáveis no painel)

| Parâmetro | Conservador (início) | Moderado | Acelerado |
|---|---|---|---|
| Máx. msgs por minuto por número | 1 | 1 | 2 |
| Intervalo entre ofertas no mesmo grupo | 25–35 min | 15–20 min | 8–12 min |
| Máx. ofertas por grupo por dia | 20 | 35 | 60 |
| Intervalo aleatório extra (jitter) | 30–120 s | 20–90 s | 10–60 s |
| Não repetir produto no grupo por | 3 dias | 2 dias | 1 dia |

Regras sempre ativas:
- Envio só dentro da janela de horário (padrão 08:00–20:30, editável por grupo).
- "Furar a fila" respeita o limite por minuto do número e mostra aviso.
- **Aquecimento de chip novo:** começa no conservador com teto diário reduzido.
- **Monitor de saúde:** detecta número desconectado ou banido, pausa a fila e alerta o operador.
- Criação automática de grupos **desativada** (é ação de alto risco de ban na API não oficial).

---

## 6. Categorias pré-cadastradas (Shopee) — o operador escolhe depois

Casa e Decoração · Cozinha e Utensílios · Eletrodomésticos · Celulares e Acessórios · Eletrônicos · Informática · Áudio e Fones · Games · Moda Feminina · Moda Masculina · Calçados · Bolsas e Acessórios · Relógios · Beleza e Cuidados Pessoais · Perfumes · Saúde e Suplementos · Esportes e Fitness · Mãe e Bebê · Brinquedos · Pets · Automotivo · Ferramentas e Construção · Papelaria e Escritório · Alimentos e Bebidas

(Cada categoria do sistema é mapeada para os IDs de categoria da Shopee na implementação. A lista é editável.)

Exemplos de grupos citados: **Utensílios de casa**, **Suplementos**.

---

## 7. Fases de implementação

### Fase 1 — MVP local
- Docker Compose (Postgres, Redis, Evolution API, app)
- Coletor Shopee + link com sub IDs
- Redator IA + layout fixo
- Fila anti-ban com presets
- Envio automático + manual (prioridade / furar fila)
- Aprovação pelo painel e pelo WhatsApp pessoal
- Painel com login + 2FA, responsivo
- Dashboard: comissão, GMV, pedidos, leads por grupo/categoria/produto
- Categorias pré-cadastradas

### Fase 2 — Cupons e refinamento
- Cadastro de cupons com regras e validade
- Reciclagem dos mais vendidos e ofertas relâmpago
- Editor de layout da mensagem com prévia

### Fase 3 — VPS + domínio (ver seção 8)

### Fase 4 — Expansão
- Extensão do Chrome (captura em 1 clique, link de afiliado, importar cupons)
- Mercado Livre e Amazon (após aprovação como afiliado)
- Vários números e vários grupos com balanceamento
- (Opcional) modo SaaS multi-cliente

---

## 8. Pendências para a fase VPS + domínio

O que **não roda localmente** e fica para depois:

- [ ] Contratar a VPS (2–4 GB RAM, Ubuntu LTS) e instalar Docker
- [ ] Registrar o domínio (ex.: radarmagnata.com.br) e apontar o DNS
- [ ] HTTPS automático (Caddy ou Traefik + Let's Encrypt)
- [ ] **Link de rastreio de cliques** (`dominio/o/<id>` → Shopee), com contagem por grupo/categoria/produto
- [ ] **Link inteligente de grupos:** um link fixo que leva ao grupo com vaga e passa para o próximo quando lota
- [ ] Endurecimento do servidor: firewall (só portas 80/443/SSH), SSH só por chave, fail2ban, atualizações automáticas
- [ ] Evolution API e banco **sem exposição pública** (rede interna do Docker)
- [ ] Backup diário automático do Postgres (cópia fora da VPS)
- [ ] Monitoramento e alertas (servidor fora do ar, número desconectado)
- [ ] Rate limiting e proteção do login do painel exposto na internet
- [ ] (Opcional) **n8n** — ver seção 9

---

## 9. n8n — recomendação

**Usar como complemento, não como motor.**

- O **núcleo** (fila anti-ban, ritmo, deduplicação, sub IDs, métricas) fica **no código** do Radar Magnata. O n8n não é bom para fila com limite rígido por número, estado e regras complexas, e um erro num fluxo pode disparar mensagens em excesso.
- O **n8n é ótimo** para automações periféricas, ligadas por webhook:
  - relatório diário/semanal (WhatsApp pessoal, e-mail, Telegram)
  - exportar vendas para Google Sheets
  - alertas ("número caiu", "comissão do dia passou de R$X")
  - integrações futuras (Instagram, Telegram, CRM)
- O Radar Magnata vai expor **webhooks/eventos** (`oferta_enviada`, `venda_registrada`, `numero_desconectado` etc.) para o n8n consumir.
- Implantar o n8n **só na fase VPS**, no mesmo Docker Compose, atrás de login.

---

## 10. Segurança e qualidade (obrigatório em cada fase)

- Segredos (chaves Shopee, Anthropic, Evolution) só em variáveis de ambiente, nunca no código nem no Git
- Senhas com hash forte (argon2), 2FA TOTP, sessão segura, proteção contra força bruta
- Validação de todas as entradas; proteção contra CSRF, XSS e SQL injection
- Revisões com as skills **security-review** e **code-review** ao fim de cada fase; desenvolvimento e design com a skill **magnata-dev**

---

## 11. Perguntas em aberto

- Quais categorias ativar primeiro e em qual grupo
- Número do WhatsApp pessoal para as aprovações
- Preço atual da API da Anthropic para o orçamento da IA
- Escolha do provedor de VPS e do domínio (fase 3)
- Pasta definitiva do projeto no computador (ainda não criada)
