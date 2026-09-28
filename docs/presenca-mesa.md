# Presença na Mesa — uma tela por conta e bloqueio por ociosidade

Código: `modules/acessos/presenca.ts` (regras), `services/mesa-presenca.service.ts`
(banco), `lib/auth/aparelho.ts` (cookie do aparelho), `lib/auth/server.ts`
(`requireMesaSession`, `presencaDaPagina`), `components/board/MesaPresenca.tsx`
(navegador), `app/api/mesa/*`. Migration `0049`. Complementa o
[monitor de acessos](monitor-acessos.md) e o portão de turno.

## Para que serve

O portão de turno fecha a Mesa **fora** do plantão do dono. Dentro do plantão,
uma senha emprestada abria a Mesa de qualquer lugar ao mesmo tempo que o dono.
Duas regras fecham isso:

1. **Uma tela da Mesa por conta.** O primeiro aparelho a abrir fica com a
   vez (*lease*) enquanto a tela estiver à vista. Outro aparelho da mesma conta
   vê "Este painel está aberto em outro dispositivo" e tenta de novo sozinho.
   **Não existe botão de assumir**: com um, duas pessoas revezariam no clique.
2. **Tela parada expira.** Sem mexer o mouse, rolar, tocar ou teclar por
   `MESA_OCIOSO_MIN` (padrão 15 min), a Mesa fecha **naquele aparelho** e
   pede a senha ("Você saiu deste computador?"). Aviso 60 s antes.

Admin é isento das duas (decisão do Caio, 28/09/2026). Rádio-operador também,
mas **só na rede da Central** — ver abaixo. O resto do app (escala,
folha de ponto, banco de horas, `/medico`) não é afetado: várias sessões em
vários aparelhos continuam normais.

## Rádio-operador (papel `radio_operador`)

Quem despacha unidades na Central. Não tem escala nem médico vinculado; o
console fica aberto o turno todo, muitas vezes sem ninguém mexer na Mesa.
Decisão do Caio (28/09/2026):

| | |
|---|---|
| Mesa | só leitura (toda escrita da Mesa exige admin/chief) |
| Na rede da Central | abre; **isento** da vez única e do bloqueio por ociosidade |
| Fora da Central | fechada — o portão de turno barra (sem escala = nunca "em turno") |
| Monitor | tratado como chefia: sem "na Central fora do turno"; dois PCs da Central = mesmo lugar |

"Rede da Central" = faixa medida (3+ plantonistas no PC) ou rotulada `central`
em `/admin/acessos/redes` (`naRedeDaCentral`, `services/acessos-portao.service.ts`).
Se a faixa não puder ser conferida (erro de banco), **não** isenta.

Cadastro: `/admin/acessos` → "Rádio-operadores" (nome + e-mail). Conta nova
nasce como a do Huddle (papel `portal`, e-mail com link de 7 dias para criar a
senha) e ganha `radio_operador`; conta existente só ganha o papel. Tirar/dar de
novo: relatório da conta, com motivo. Tudo em `audit_logs` e na linha do tempo.

Limite conhecido: a isenção depende do IP. Enquanto a origem aceitar pedido que
não vem do Cloudflare, dá para forjar `cf-connecting-ip` e parecer estar na
Central — com a senha de um rádio-operador, isso abre a Mesa sem bloqueio fora
de lá.

## Aparelho

Cookie próprio `__Host-plantoes_aparelho` (em dev, `plantoes_aparelho`):
id aleatório assinado com `AUTH_SECRET`, HttpOnly, 400 dias, emitido pelo
`proxy.ts` em qualquer pedido que chegue sem ele. Duas abas do mesmo navegador
= mesmo aparelho = dividem a vez. Quem recebe só a senha entra de outro
navegador = outro aparelho. O `__Host-` impede que um subdomínio irmão de
mnrs.com.br plante um aparelho aqui. Nada que o cliente mande no corpo é
aceito como aparelho.

Limite: quem copia os cookies de um navegador leva o aparelho junto. É o
próximo degrau (passkey), ver "Próximos passos".

## A vez (lease)

| | |
|---|---|
| Batida | a cada ~15 s (±2 s), **só com a aba visível**: `POST /api/mesa/presenca {visivel, paradoSeg}` |
| Validade | 45 s — três batidas perdidas (4G oscilando) antes de perder a vez |
| Aba escondida / celular bloqueado / notebook dormindo | não bate; a vez vence sozinha em até 45 s |
| Aba fechada | `sendBeacon` para `/api/mesa/presenca/liberar`: solta na hora |
| Restart do deploy | quem estava com a vez ganha +60 s (uma vez por processo) |
| Duas batidas do mesmo aparelho em < 4 s | 429, sem tocar no banco |

Tabela `view_leases`, uma linha por conta × recurso. A troca de dono é **uma
query** (`INSERT … ON CONFLICT DO UPDATE … WHERE mesmo aparelho OR vencida`):
a trava de linha do Postgres garante que, de dois aparelhos abrindo juntos,
exatamente um ganha. O relógio é o do banco. Soltar a vez é vencê-la (não
apagar): o `epoch` sobe a cada troca e a troca vira evento.

**Por que Postgres e não Redis:** um processo web só, ~3 batidas/s no pico, e
o lease precisa sobreviver ao restart (em memória, quem pegou a senha ganharia
a vez durante o deploy). Redis seria mais uma peça para cair num servidor
compartilhado com ~10 apps.

## Onde vale (backend, não só tela)

`requireMesaSession` — usado por `/api/board*`, regulação, intervenção,
operacional — confere, depois do portão de turno: aparelho não bloqueado **e**
com a vez. Senão:

| Situação | Resposta |
|---|---|
| fora do plantão (portão) | 403 |
| aparelho bloqueado por ociosidade | 401 (o quadro recarrega e mostra a tela de bloqueio) |
| outro aparelho com a vez | **423** `VIEW_LEASE_HELD` |

A página `/` (e `/historico/turno-anterior`) não monta nenhum dado do quadro
nesses casos. O SSE `/api/board/stream` reconfere a cada 30 s e fecha com
`acesso-encerrado`. Sem batida recente não há vez — apagar o script da página
não mantém o quadro.

Abrir a página por navegação pega a vez; o refresh automático (RSC) e o
prefetch só conferem.

## Ociosidade

O navegador guarda só "quando foi a última interação" (`pointerdown`,
`pointermove`, `keydown`, `wheel`, `touchstart`, `scroll`) e manda
"parado há N s" na batida. Nada vai ao servidor por evento.

O servidor guarda `view_presence.last_human_at` por conta × aparelho e bloqueia
(`locked_at`) quando passa do limite — inclusive quando a batida só chega
depois (notebook que dormiu, aba que ficou escondida). **Abrir ou recarregar a
página não zera o relógio**: F5 numa tela esquecida, ou a Mesa reaberta no PC
da Central horas depois, cai no bloqueio. Zeram: a senha na tela de bloqueio
(`POST /api/mesa/desbloquear`, mesmo limite de tentativas do login) e o login
com e-mail e senha naquele aparelho. O SSO do portal **não** zera (não pede
senha). Bloquear solta a vez na hora: o dono abre no outro aparelho sem esperar.

"Não é você? Entrar com outra conta" sai e vai ao `/entrar` (login local) — o
portal lembraria a conta anterior.

**O que o sinal de presença não prova.** "Mexer o mouse" vem do JavaScript da
página: um *mouse jiggler* ou um script mantém UMA tela viva. Não abre uma
segunda (a vez não depende disso), não passa do turno do dono (portão) e fica
registrado. A ociosidade protege contra tela esquecida; contra senha
compartilhada quem protege é a vez + portão + monitor.

Efeito na Central: Mesa num segundo monitor enquanto o médico trabalha em outro
sistema fecha em 15 min se ninguém passar o mouse por ela. Ajuste em
`MESA_OCIOSO_MIN` (5–240).

## O que o monitor passa a ver

Eventos em `auth_session_events` (com `device_id`), na linha do tempo da conta:

| Evento | Quando |
|---|---|
| `mesa_troca_de_aparelho` | a vez passou de um aparelho a outro |
| `mesa_ocupada_negada` | aparelho esperou a vez (10 em 10 min); `humanoAqui`/`humanoLa` = segundos desde a última interação nos dois lados |
| `mesa_bloqueada_ociosa` | tela parada, aparelho bloqueado |
| `mesa_desbloqueada` | senha digitada, aparelho liberado |
| `*_sombra` | o que teria acontecido, com `MESA_PRESENCA` em sombra |

Achados novos (`achadosDaPresenca` em `modules/acessos/analise.ts`):

| Achado | Nível | Regra |
|---|---|---|
| Mesa aberta em dois aparelhos com gente mexendo nos dois | **forte** | negada com interação nos dois lados nos 2 min anteriores |
| Mesa disputada entre aparelhos | atenção | 2+ negadas no período (pode ser o dono no PC e no celular) |
| A Mesa revezando entre aparelhos | atenção | 4+ trocas em 30 min (ping-pong) |

Trocar do PC para o celular uma vez não gera nada. IP e localização não entram
nessas regras.

## Ligar, medir, desligar

| `MESA_PRESENCA` | Efeito |
|---|---|
| vazio (padrão) ou `sombra` | batidas e eventos `*_sombra`; **ninguém é bloqueado** |
| `1` | vale |
| `0` | nada roda |

`MESA_OCIOSO_MIN` = minutos até bloquear (padrão 15). Mudou o `.env.production`:
`pm2 delete plantoes && pm2 start` (o PM2 não relê o env).

Rollout: migration 0049 **antes** do merge → deploy em sombra → uma semana
olhando `mesa_ocupada_negada_sombra` e `mesa_bloqueada_ociosa_sombra` por conta
(quantos legítimos seriam barrados; quantos avisos de ociosidade por turno) →
`MESA_PRESENCA=1`. Emergência: `MESA_PRESENCA=0`. Erro de banco deixa passar
(log `[presenca]`), como o portão.

## Próximos passos (não feitos)

- **Passkey (WebAuthn)** fora da Central: cadastro do aparelho e *step-up*
  quando o achado for forte; destravar lease preso só com passkey + 2 h sem
  interação do outro lado. PCs da Central não suportam — lá fica a senha.
- **Aparelhos confiáveis**: lista em `/medico`, teto de 4 pessoais, revogação.
- **Tabela**: mesma vez pelo `/api/servicos/portal/acesso` (repos kairos e tabela).
- **Bloqueio derrubar o login do portal** no navegador (porteiro, repo kairos).
- **Origem só pelo Cloudflare** no nginx do magalu: hoje dá para forjar
  `cf-connecting-ip` batendo direto na origem e passar pelo portão como Central.
