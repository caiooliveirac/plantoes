# Monitor de acessos — senha compartilhada e uso simultâneo

Tela: **`/admin/acessos`** (só admin). Avisos: privado dos admins no Telegram.
Código: `lib/acessos/`, `modules/acessos/`, `services/acessos*.service.ts`,
`app/admin/acessos/`, `modules/telegram/acessos-alerts.ts`. Migration `0046`.

## Para que serve

Havia suspeita de gente passando a senha para outra pessoa ver a Mesa de outro
lugar. O monitor registra quem entrou, de onde, em qual aparelho e o que fez, e
aponta quando **a mesma conta estava em uso em lugares diferentes ao mesmo
tempo** — com a linha do tempo que prova isso, em português, pronta para
imprimir.

**Nada bloqueia sozinho** (decisão do Caio, 27/09/2026). O monitor avisa e
documenta; cortar acesso é sempre um clique do admin, com motivo, no relatório
da conta.

## O que é registrado

| Tabela | Uma linha por | Guarda |
|---|---|---|
| `auth_sessions` | login (um navegador/aparelho) | como entrou (`origin`), IP, aparelho e local da entrada, último uso, encerramento |
| `auth_session_activity` | sessão × IP × janela de 5 min | pedidos, quantos com a Mesa à vista, quantos com gente mexendo |
| `auth_session_events` | interação | entrada, página aberta, ação (POST/PATCH/DELETE), quadro ao vivo, rede nova, senha digitada (certa/errada), saída, SSO recusado, ações do admin |
| `auth_network_info` | IP | localização (Cloudflare) e provedor (DNS reverso) |

Não se grava senha, conteúdo de formulário nem cookie. Caminho de página com
cara de segredo (token de redefinição, convite) vira `…`.

**Sessão = `sid` no cookie.** Cada login/SSO/cadastro gera um `sid` novo
(`lib/auth/server.ts`, `writeSessionCookie`). A renovação diária do `proxy.ts`
mantém o `sid`. Cookie emitido antes do monitor ganha um id derivado dele mesmo
(`legacySessionId`, uuid v8) e a sessão nasce com `origin = "anterior"` na
primeira visita — a data real daquele login é desconhecida.

**Quando grava.** O portão (`readAuthenticatedSession`) registra cada pedido
autenticado depois da resposta (`after()` do Next): não atrasa a Mesa. Presença
e "último uso" vão ao banco no máximo uma vez por minuto por sessão × IP (o
resto soma em memória — o web é um processo PM2 só). Erro de gravação vira uma
linha de log `[acessos]`; nunca derruba login nem quadro.

> O quadro "não grava ao ler" (docs/bug-hotspots.md, padrão 4) continua valendo:
> isto é registro de segurança fora do read model, gravado depois da resposta.

## De onde vem cada dado

- **IP**: `cf-connecting-ip` (o Cloudflare fica na frente). O `X-Real-IP` do
  nginx do magalu é o IP do Cloudflare, não do cliente — só serve no dev/LAB.
  `x-forwarded-for` só vale nas chamadas internas (porteiro → `verificar-escala`).
- **Localização**: cabeçalhos do Cloudflare. País (`cf-ipcountry`) sempre. Cidade,
  região e coordenadas **só com o Managed Transform "Add visitor location
  headers" ligado** na zona mnrs.com.br (Regras → Transformações gerenciadas).
  Sem ele, a tela avisa e mostra só o país. É aproximada: operadora de celular
  às vezes aparece em outra cidade.
- **Provedor**: DNS reverso do IP (Claro, Vivo, Oi, TIM… ou "nuvem/VPN"),
  refeito a cada 7 dias. Muito 4G não tem nome reverso — fica "—".
- **Aparelho**: user-agent ("celular Android 13 SAMSUNG SM-A536E com Samsung
  Internet 23"). Declarado pelo navegador: prova fraca sozinho, forte junto com
  rede e horário.
- **Uso da Mesa**: o quadro manda `x-mesa-uso: v=1;o=12` em cada consulta
  (aba visível; 12 s desde o último toque/clique/tecla/rolagem). "Em uso" =
  visível e mexida nos 2 minutos anteriores, ou página aberta/ação feita.

## Como a análise decide (`modules/acessos/analise.ts`)

**Rede** é a unidade de lugar: IPv4 inteiro (casa, Central e 4G saem por um IP
público cada), IPv6 por prefixo /64. Rede usada por **3+ contas** no período é
**coletiva** (Central, hospital, base).

**Janela simultânea**: janela de 5 min com duas sessões diferentes em redes
diferentes. Janelas simultâneas seguidas (até uma vazia no meio) formam um
**episódio**. O trecho mostrado vai de quando a 2ª rede apareceu até a
penúltima sair.

### Força do episódio

| Força | Quando | Por quê |
|---|---|---|
| **Forte** | 3+ redes ao mesmo tempo (não todas coletivas) | Uma pessoa não está em três lugares. |
| **Forte** | uso ativo nos dois lados em **2+ janelas**, com dois computadores (ou dois celulares) | Ninguém opera dois computadores em dois lugares. |
| **Forte** | uso ativo nos dois lados em **4+ janelas** com celular + computador | Uma pessoa alterna entre celular e PC por alguns minutos; 20 min em paralelo, não. |
| **Forte** | cidades a **50+ km** e tela à vista nos dois lados em 2+ janelas | Distância com tela aberta dos dois lados. |
| Moderado | uso ativo nos dois em 1 janela; ou tela à vista nos dois em 2+; ou 30+ min abertos nos dois; ou 50+ km | Sinal real, mas com explicação inocente possível. |
| Fraco | o resto | Típico de trocar do PC para o celular com a aba ainda aberta. |

**Rebaixa um nível** (com a ressalva escrita): todas as redes coletivas (pode
ser o mesmo prédio com duas saídas de internet); uma rede IPv4 e outra IPv6 sem
distância conhecida (podem ser dois aparelhos da mesma casa).

Aba esquecida: o computador de casa que ficou com a Mesa aberta continua
consultando sozinho. Sem toque nos dois lados, nunca passa de moderado.

### Outros achados (atenção)

| Achado | Limite |
|---|---|
| Deslocamento impossível | cidades a 300+ km em sequência, a mais de 800 km/h |
| Senha digitada em muitos lugares | senha certa de 3+ redes em 24 h (portal ou login) |
| Tentativas de senha errada | 5+ no período |
| Muitos aparelhos | 5+ user-agents diferentes (PCs iguais da Central contam como um) |
| Sessão fora de navegador | user-agent de programa (curl, Python…) — cookie copiado? |
| Fora do Brasil | rede com país ≠ BR (viagem, VPN, Retransmissão Privada do iCloud) |
| Servidor/VPN | provedor de nuvem ou VPN comercial |
| Mesma sessão em duas redes | mesmo cookie em duas redes da mesma família em 3+ janelas |

**Nível da conta**: forte se houver episódio forte; atenção se houver qualquer
achado de atenção (inclui episódio moderado); senão normal. A lista ordena por
episódios fortes, depois moderados, depois recência.

Os limites moram em `LIMITES` (analise.ts). Mudou algum? Atualize esta tabela e
`tests/monitor-acessos.test.ts`.

## Plano de alertas (Telegram)

Para os `TELEGRAM_ADMIN_IDS`, pelo `plantoes-telegram-worker`
(`modules/telegram/acessos-alerts.ts`). **Liga com `ACESSOS_ALERTAS_ENABLED=1`
no `.env.production`** (e `pm2 delete/start` do worker — o PM2 não relê o env).

1. **Na hora** — episódio **forte** que terminou há menos de 20 min (ou segue).
   Checa a cada 2 min, olhando as últimas 3 h. No máximo um aviso por conta a
   cada 3 h por admin. Diz quem, quando, cada aparelho com rede/cidade/provedor,
   o porquê e a ressalva, e o link do relatório.
2. **Resumo diário às 8h** (Bahia) — contas forte e atenção das últimas 24 h, uma
   linha cada. Sai **todo dia, mesmo vazio**: é a prova de que o monitor está vivo.
3. **Retenção** — na janela das 8h, apaga o que passou de 180 dias (sem flag).

Deduplicação em `telegram_bot_notices` (reserva idempotente; falha de envio
solta a reserva para o próximo ciclo tentar).

## Ações do admin (e o que cada uma corta de verdade)

No relatório da conta, cada uma com motivo obrigatório (vai para `audit_logs` e
para a linha do tempo):

| Ação | Efeito | Corta quem tem só a senha emprestada? |
|---|---|---|
| Encerrar uma sessão | aquele aparelho cai | não — volta pelo portal ou digitando a senha |
| Encerrar todas as sessões | `session_version` + 1: todo cookie daqui cai | não — quem sabe a senha entra de novo (e aparece aqui) |
| Trocar a senha e mandar link | senha aleatória que ninguém conhece, tudo cai, link de 24 h ao e-mail da conta | **sim** |
| Suspender / reativar | `is_active` — ninguém entra, nem o dono | sim, até reativar |

**Portal (mnrs.com.br)**: o porteiro guarda login próprio por 30 dias e reabre o
plantões pelo `/api/auth/sso` sem pedir senha. Desde este monitor, o SSO recusa
handoff com `sv` (versão da sessão) diferente da atual — então "encerrar todas"
e troca de senha derrubam também o login do portal. **Depende do porteiro mandar
o `sv`** (PR no kairos, `deploy/porteiro`): antes dele, só "trocar a senha" e
"suspender" cortam quem entra pelo portal. Handoff vindo do app Escalas ainda
não leva `sv` — quem tem sessão aberta lá consegue abrir o plantões até ela
vencer (dívida registrada).

## Limitações conhecidas

- IP de celular (CGNAT) muda várias vezes por dia e é dividido com estranhos;
  por isso contagem de redes sozinha não vira alerta.
- Um aparelho pode alternar IPv4/IPv6: fica na mesma sessão, não vira episódio.
- VPN, iCloud Private Relay e Cloudflare WARP mudam o lugar aparente.
- Quem acessar o servidor sem passar pelo Cloudflare poderia forjar
  `cf-connecting-ip` (o nginx não restringe às faixas do Cloudflare).
- A Central com mais de um IP de saída aparece como duas redes coletivas — o
  episódio é rebaixado e a ressalva diz isso.

## Retenção e dados pessoais

IP, aparelho e localização aproximada são dados pessoais (LGPD): finalidade é
segurança da conta e da operação; guardados 180 dias; tela só para admin.
Reverter tudo: `db/migrations/down/0046_monitor_acessos.sql` (apaga a prova —
exporte antes o relatório de quem estiver sob apuração).

## Operação

1. Migration `0046_monitor_acessos.sql` **antes** do merge (só tabelas novas;
   procedimento em docs/agent-operations.md). Sem ela o app segue igual — só não
   registra, e a tela diz que falta a migration.
2. Cloudflare: ligar "Add visitor location headers" para ter cidade.
3. `ACESSOS_ALERTAS_ENABLED=1` no `.env.production` para os avisos.
4. Porteiro com `sv` (PR no kairos) para "encerrar todas" valer no portal.
