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

**Heurística nunca bloqueia; regra bloqueia** (decisão do Caio, 28/09/2026 —
substitui "nada bloqueia sozinho" de 27/09). Episódios e achados avisam e
documentam; cortar por eles é um clique do admin. Duas regras objetivas agem
sozinhas — ver [Portão de turno e limite de lugares](#portão-de-turno-e-limite-de-lugares).

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

### Plantão: uso de trabalho soa diferente (`aplicarPlantao`)

Quem está de plantão usa a Mesa o turno inteiro, às vezes em dois PCs da
Central. Isso é trabalho, não senha emprestada — o monitor precisa saber a
diferença.

- **Turno** = ocupação do quadro (regulação ou intervenção) do médico vinculado
  à conta (`users.doctor_id`): de `started_at` até `actual_ended_at`, senão
  `ended_at`, senão aberta (no máximo 24 h — ocupação esquecida aberta não deixa
  ninguém de plantão para sempre). Tolerância de 30 min antes e depois. Conta sem médico
  vinculado não tem turno para comparar e segue a regra geral.
- **Rede do plantão** = faixa de endereços (**/24** no IPv4, /64 no IPv6) onde
  **3 ou mais plantonistas** diferentes usaram a Mesa **num computador** *dentro
  do próprio turno*. Nada é cadastrado à mão: a faixa vira rede do plantão pelo
  comportamento de quem trabalha.
  - Por que faixa e não IP: a Central sai para a internet por um **pool de IPs**
    da mesma /24 — cada PC aparece com um IP diferente (medido em 27/09/2026: 9
    IPs, 8 contas, 5 plantonistas numa só /24). Por IP exato ninguém dividiria
    rede com ninguém.
  - Por que só computador: faixa de operadora 4G junta desconhecidos; dois
    plantonistas no celular na mesma /24 da Vivo não fazem dela a Central.
    Depois de formada, a faixa vale para qualquer aparelho (celular no Wi-Fi da
    Central também está na rede do plantão).

| Situação no meio do episódio | Resultado |
|---|---|
| De plantão, **todos** os aparelhos na rede do plantão | **fraco** — "uso de trabalho", não pesa no risco |
| De plantão na rede do plantão + **computador em uso fora dela** | **forte** — alguém usa o login enquanto o dono trabalha; não é o celular dele |
| De plantão na rede do plantão + só **celular/tablet** fora | desce um nível — pode ser o celular do próprio plantonista, no 4G |
| De plantão, nenhum aparelho em rede do plantão | regra geral, com ressalva |
| Fora do turno, **todos** os aparelhos na rede do plantão | é o mesmo lugar (IPs do pool): chefia/admin **fraco**; os demais descem um nível |
| Fora do turno, algum aparelho fora | regra geral |

Também muda: "Muitos aparelhos" não conta os PCs usados só na rede do plantão
durante o turno; sobreposições curtas repetidas só pesam fora do turno; e o
achado novo **"Na rede do plantão fora do turno do dono"** (atenção) aparece
quando a conta ficou 30+ min em uso na rede do plantão sem o dono estar de
plantão (1 h de folga ao redor de cada turno) — outra pessoa usando o login na
Central. Chefia e admin não recebem esse achado: trabalham lá fora da escala.

No painel, a faixa verde sob o calor e a primeira raia de "Quem está onde" são o
turno; "rede do plantão" aparece no nome da rede e nos lugares. O critério de
ranking "Na Central fora do turno" ordena por esse tempo.

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
| Na rede do plantão fora do turno do dono | 30+ min em uso na rede do plantão, 1 h longe de qualquer turno do dono (não vale para chefia/admin) |

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

## Portão de turno e limite de lugares

Regras em `modules/acessos/portao.ts`; banco, cache e ação em
`services/acessos-portao.service.ts`. Ligadas desde o deploy (sem sombra, decisão
do Caio). Desligar em emergência: `ACESSOS_PORTAO_TURNO=0` /
`ACESSOS_LIMITE_LUGARES=0` no `.env.production` + `pm2 delete/start plantoes`.

### Mesa e Tabela só de plantão

| Quem | Mesa (`/`, `/api/board*`, regulação, intervenção, operacional, turno anterior) e Tabela (abas Tabela, Casos, Destino, UPAs) |
|---|---|
| admin | sempre |
| qualquer outra conta (chefia inclusive) em turno | sim, de qualquer lugar |
| fora do turno, **na rede do plantão** (faixa da Central) | sim — quem chegou e ainda não declarou no bot não fica sem a Mesa |
| fora do turno, fora da Central | **não**: Mesa mostra "Mesa fechada fora do plantão"; API 403; Tabela 403 |

- **Turno** = ocupação (regulação ou intervenção) do médico da conta, de 30 min
  antes da chegada até 1 h depois da saída real (senão prevista, senão 24 h).
  Conta sem médico vinculado nunca está em turno: só admin ou Central.
- **Rede do plantão** = a mesma de "Plantão: uso de trabalho" acima, olhando 14
  dias, recalculada a cada 15 min.
- Checado **a cada pedido**, não no login: trocar ou emprestar a senha não abre
  nada fora do turno do dono. Resposta guardada 60 s por conta.
- Erro de banco deixa passar (a Mesa é operação de emergência) e vira log
  `[acessos] portão`.
- Folha de ponto, banco de horas, `/medico`, troca de senha seguem abertos.
- Barrado vira evento `barrado_fora_do_plantao` (de 10 em 10 min por sistema) e
  o achado de atenção "Tentou abrir a Mesa ou a Tabela fora do plantão".
- Tabela: `POST /api/servicos/portal/acesso` com `sistema = "tabela"` recusa com
  `motivo: "fora_do_plantao"`; o porteiro (kairos) responde **403** no `/portao`
  (401 mandaria ao login do portal, que está logado — laço). O cache do
  porteiro é por sessão × IP × sistema, para a recusa da Tabela não derrubar o
  portal. **Deploy do porteiro antes do plantões.**
- WebSocket da Tabela já aberto não é reconferido até reconectar (limitação do
  `auth_request`, igual à revogação).

### Mais de 3 lugares ao mesmo tempo: derruba tudo

**Lugar** = faixa de rede (/24 IPv4, /64 IPv6). Faixas usadas pela mesma sessão
contam como um lugar (4G trocando de IP, IPv4/IPv6 no mesmo aparelho); vários
PCs da Central são um lugar. "Ao mesmo tempo" = visto nos últimos 5 min. Conta
em memória, a cada pedido da Mesa e do portal.

Com **4+ lugares**: senha trocada por uma aleatória, `session_version` + 1, todas
as sessões encerradas (Mesa, portal, Tabela em até 1 min), link de redefinição
de 24 h no e-mail da conta, aviso aos `TELEGRAM_ADMIN_IDS`. Evento
`auto_exigir_nova_senha`, `audit_logs` com ator nulo. Uma vez a cada 15 min por
conta. **Admin não cai**: só evento `lugares_demais_admin` (o alerta de episódio
forte já avisa).

Por que lugar e não sessão: em 7 dias até 28/09/2026, contando sessões (cookies)
10 contas passariam de 3 — todas em 1–2 redes (o portal gera vários `sid` por
navegador; cada navegador tem cookie da Mesa e do portal). Contando lugares, o
máximo visto foi 3.

### Uma tela da Mesa por conta e tela parada que expira

Dentro do turno, a Mesa só fica à vista num aparelho por conta, e tela sem
interação fecha e pede a senha. Regras, eventos e achados em
[presenca-mesa.md](presenca-mesa.md).

## Redes (`/admin/acessos/redes`)

Visão por **faixa** (/24, /64) em vez de por conta: onde as contas são usadas
fora do plantão, quem provavelmente emprestou a senha, e o que o portão trata
como Central. Regras em `modules/acessos/redes.ts`, carga em
`services/acessos-redes.service.ts`. "Fora do plantão" usa a mesma folga do
portão (30 min antes, 1 h depois).

**Veredito por conta numa rede que não é a Central:**

| Veredito | Quando |
|---|---|
| vazou (provável) | em uso ali em 2+ janelas de 5 min em que o dono estava na Central |
| suspeita | em uso ali e noutra rede na mesma janela 3+ vezes (pode ser 4G + PC da mesma pessoa) |
| uso próprio | fora do turno, mas no mesmo navegador (mesma sessão) que o dono usou no plantão |
| aparelho estranho | fora do turno, navegador que nunca apareceu no plantão do dono |
| trabalho | só dentro do turno |

User-agent não serve para "mesmo aparelho" (todo Chrome de Windows manda o
mesmo texto); a sessão (cookie) serve.

**Rede coletiva fora do plantão** = 3+ contas com uso fora do turno (ou
barradas), fora da Central. Com 2 é quase sempre casa de casal de médicos ou
celular com duas contas (1º ciclo em 28/09: 5 faixas de 2 contas, todas
residenciais/4G) — aparece no painel, não avisa. Ordenadas por pontuação (minutos fora + contas² +
barrados + vazamentos). O histograma por hora mostra o padrão: horário
comercial = local de trabalho.

**Rótulos** (tabela `auth_network_labels`, migration 0048), com audit_log:
- `central` — a faixa entra na rede do plantão do portão **na hora**, mesmo sem
  3 plantonistas medidos. É a garantia de que um PC da Central abre Mesa e
  Tabela. Ex.: `COI (SSP)`, a central da polícia (ssp.ba.gov.br), 1 IP, onde
  só 1–2 plantonistas trabalham — a medida nunca chegaria a 3.
- `suspeita` / `conhecida` — só nomeiam (Vitalmed, hospital). `conhecida` não
  gera aviso.

A seção "Central — o que o portão reconhece" lista as faixas Central (medida ou
rótulo) e as que têm plantonista no PC mas **não** são reconhecidas.

**Vigia no Telegram** (`modules/telegram/acessos-alerts.ts`, a cada 30 min,
olhando 7 dias): rede coletiva fora do plantão ou com vazamento provável (de
novo quando cresce, máx. 1×/24 h por rede); e "possível Central não
reconhecida" — faixa com 2+ plantonistas no PC que já teve barrado (1×/dia;
com 1 só costuma ser o notebook de um médico).

## Ações do admin (e o que cada uma corta de verdade)

No relatório da conta, cada uma com motivo obrigatório (vai para `audit_logs` e
para a linha do tempo):

| Ação | Efeito | Corta quem tem só a senha emprestada? |
|---|---|---|
| Encerrar uma sessão | aquele aparelho cai | não — volta pelo portal ou digitando a senha |
| Encerrar todas as sessões | `session_version` + 1: todo cookie daqui cai | não — quem sabe a senha entra de novo (e aparece aqui) |
| Trocar a senha e mandar link | senha aleatória que ninguém conhece, tudo cai, link de 24 h ao e-mail da conta | **sim** |
| Suspender / reativar | `is_active` — ninguém entra, nem o dono | sim, até reativar |

**Portal (mnrs.com.br)**: o porteiro guarda login próprio por 30 dias
(`mnrs_sso`, com `sid` e `sv` desde 27/09/2026) e reabre o plantões pelo
`/api/auth/sso` sem pedir senha. O SSO recusa handoff com `sv` (versão da
sessão) diferente da atual — então "encerrar todas" e troca de senha derrubam
também o login do portal. Handoff vindo do app Escalas ainda não leva `sv` —
quem tem sessão aberta lá consegue abrir o plantões até ela vencer (dívida).

## Tabela (e Triagem): o login do portal também é vigiado

A Tabela não tem login próprio: o nginx pergunta ao porteiro a cada pedido
(`auth_request` → `/_auth/portao`) se o cookie do portal vale. Desde
27/09/2026 o porteiro também pergunta ao plantões —
`POST /api/servicos/portal/acesso` (token de serviço `ESCALA_SSO_TOKEN`) — se
**aquela sessão do portal** ainda vale:

- recusa conta inexistente, suspensa, sem papel, ou `sv` antigo (senha trocada,
  "encerrar sessões"). Recusado = "sem sessão": Tabela volta ao login do portal
  e o `/sessao` do portal mostra deslogado. Cada recusa vira evento
  `portal_recusado` na linha do tempo da conta;
- aceita e **registra o uso**: o login do portal vira uma sessão de origem
  `portal_cookie` (o `sid` do cookie), com IP, aparelho e localização que o
  porteiro repassa, pedidos somados por minuto, página aberta (`/tabela/`),
  ações (POST/PATCH/DELETE) e WebSocket. Caminho sem query string: a Tabela
  manda endereço de ocorrência em `?local=`.

O porteiro guarda a resposta por 60 s por sessão × IP: suspender ou encerrar
sessões corta a Tabela em até 1 minuto. **Plantões fora do ar = a sessão passa**
(sem resposta, o porteiro não derruba a Tabela a cada deploy do plantões);
recusa já guardada continua valendo. Para saber sistema, caminho e método, o
bloco `/_porteiro_tabela` do nginx manda `X-Mnrs-Sistema`, `X-Original-URI` e
`X-Original-Method` (fonte: `nginx-host.conf` do repo tabela). Sem eles o uso
ainda é registrado, como "portal".

Assim um login emprestado da Tabela aparece no mesmo relatório e nos mesmos
alertas que o da Mesa: Tabela aberta em casa enquanto a Mesa está em uso na
Central é uso simultâneo em redes diferentes.

## Limitações conhecidas

- IP de celular (CGNAT) muda várias vezes por dia e é dividido com estranhos;
  por isso contagem de redes sozinha não vira alerta.
- Um aparelho pode alternar IPv4/IPv6: fica na mesma sessão, não vira episódio.
- VPN, iCloud Private Relay e Cloudflare WARP mudam o lugar aparente.
- Quem acessar o servidor sem passar pelo Cloudflare poderia forjar
  `cf-connecting-ip` (o nginx não restringe às faixas do Cloudflare).
- A Central com mais de um IP de saída aparece como duas redes coletivas — o
  episódio é rebaixado e a ressalva diz isso.
- Rede do plantão depende de 3+ plantonistas com conta vinculada ao médico
  usando a Mesa num PC na mesma faixa durante o turno. Base de ambulância (médico
  no celular) não forma rede do plantão — o episódio segue a regra geral.
- A faixa /24 pode incluir vizinhos do mesmo provedor da Central; o risco é
  pequeno porque só pesa junto com o turno do dono.
- Turno vem do quadro: plantão registrado com atraso (chegada tardia) ou saída
  sem registro distorcem a janela; a folga de 30 min absorve o comum.

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
4. Porteiro com `sv` e a conferência do `/portao` (PRs no kairos) para "encerrar
   todas", troca de senha e suspensão valerem no portal e na Tabela.
