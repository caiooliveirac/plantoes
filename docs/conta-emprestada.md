# Compêndio — conta emprestada e tela esquecida

O problema: alguém usa a conta de outro médico na Mesa. Ou porque recebeu a
senha (compartilhamento), ou porque o dono deixou a tela aberta e foi embora
(esquecimento). Aqui fica **tudo o que já tentamos**, o que ficou de fora e
por quê. Detalhes de cada regra moram nos documentos apontados.

## No ar

| Data | Medida | Contra | Onde |
|---|---|---|---|
| 27/09/2026 | Monitor de acessos: sessão por login, rede, aparelho, uso da tela; episódios de uso simultâneo; alertas no Telegram | os dois (prova) | [monitor-acessos.md](monitor-acessos.md) |
| 27/09/2026 | Conta compartilhada `chefe@samu.local` suspensa: cada chefe com a sua | compartilhamento | memória do projeto |
| 28/09/2026 | Portão de turno: Mesa e Tabela só de plantão (admin e Central à parte); 4+ lugares ao mesmo tempo troca a senha | compartilhamento | [monitor-acessos.md](monitor-acessos.md#portão-de-turno-e-limite-de-lugares) |
| 28/09/2026 | Risco alto derruba as sessões; se insistir em 24 h, troca a senha (admin isento) | compartilhamento | `modules/acessos/atitude.ts` |
| 01/10/2026 | Corte da virada: sessão não-admin aberta antes de 07:00/19:00 cai às 07:15/19:15 (plantoes e porteiro do portal) | esquecimento na troca de turno | [presenca-mesa.md](presenca-mesa.md#corte-da-virada-e-trava-da-2031-01102026) |
| 01/10/2026 | Trava da 2031: chief que não é o chefe de plantão só olha | conta de chefia emprestada | idem |
| 01/10/2026 | **Vez única valendo**: uma tela da Mesa por conta; o 2º aparelho espera | compartilhamento | [presenca-mesa.md](presenca-mesa.md) |
| 01/10/2026 | **Ociosidade 30 min**: tela parada pede a senha com "Ainda é Fulano?" | esquecimento | idem |
| 01/10/2026 | **Trocar de aparelho trava o anterior**: a Mesa passou do PC ao celular, o PC só volta com a senha | os dois | [presenca-mesa.md](presenca-mesa.md) |
| 01/10/2026 | **"Usar aqui" com senha** na tela "aberto em outro dispositivo": tira a Mesa do aparelho esquecido, que trava | esquecimento | `POST /api/mesa/assumir` |
| 01/10/2026 | **Saída registrada fecha a Mesa em 10 min** (era 60) e tira a conta da exceção da Central por 6 h (chefia isenta) | esquecimento no PC da Central | `modules/acessos/portao.ts` |
| 01/10/2026 | Cloudflare: rate limit de senha — 8 POSTs por IP em 10 s no `/_auth/entrar`, `/api/auth/login` e `/api/mesa/desbloquear` (bloqueio de 10 s) | força bruta | regra `login_forca_bruta`, fase `http_ratelimit` |
| 01/10/2026 | Falsos positivos da derrubada automática: "lugar" junta faixa /24, aparelho, celular trocando de IP, Retransmissão Privada do iCloud; loopback ignorado; conta compartilhada de propósito (`interno.samu`) isenta | — (precisão) | [monitor-acessos.md](monitor-acessos.md) |

### Por que o corte da virada não é "conectado há mais de 1 h"

A regra que vale é **mais dura**: qualquer sessão aberta antes das 07:00/19:00
cai às 07:15/19:15, mesmo com 20 min de vida. Trocar por "mais de 1 h" abriria
um buraco: o SSO do portal emite uma sessão nova do app a cada entrada, então a
sessão do plantoes de quem saiu às 06:50 teria 25 min e passaria. O custo da
regra dura é quem chegou entre 06:00 e 07:00 digitar a senha de novo às 07:15.

## Cloudflare (MCP) — tentativa de 01/10/2026

Primeira tentativa: o token do MCP (`cloudflare-api`) só lia a zona. O Caio
acrescentou **Transform Rules, Zone WAF e Firewall Services (Edit)** e o rate
limit foi criado pelo MCP. Managed Transforms (`/managed_headers`) ainda
recusa: pede a permissão **Managed headers**, ou o interruptor no painel
(Rules → Settings → Managed Transforms).

| Medida no Cloudflare | Ganho | Estado |
|---|---|---|
| Managed Transform "Add visitor location headers" | cidade e coordenadas no monitor: ativa o critério de distância (50+ km) e o deslocamento impossível | pendente (interruptor no painel) |
| Origem só aceita o Cloudflare (Authenticated Origin Pulls + `allow` das faixas do Cloudflare no nginx) | ninguém forja `cf-connecting-ip` batendo direto no magalu para parecer estar na Central | pendente (nginx do magalu + certificado) |
| Rate limit em `/_auth/entrar`, `/api/auth/login`, `/api/mesa/desbloquear` (regra grátis: 1 por zona) | força bruta de senha barrada na borda, antes do app | **no ar 01/10/2026** |
| Turnstile no login do portal | robô não testa senha vazada | ideia |
| Regra WAF: login de fora do Brasil vira desafio | senha vazada usada de VPN estrangeira | ideia — atrapalha viagem e Retransmissão Privada |

## Ideias ainda não feitas (em ordem de ganho)

1. ~~Saída registrada derruba as sessões do dono~~ — feito pelo portão (10 min, Central inclusa).
2. **Escrita sensível pede a senha de novo** (confirmar saída, remanejar,
   abonar atraso) se a última senha digitada tiver mais de 30 min. Quem pegou
   a tela aberta consegue olhar, mas não age em nome do dono.
3. **Último acesso na tela de entrada**: "último acesso: PC da Central, hoje
   07:02". O dono percebe sozinho quando alguém entrou por ele.
4. **Aviso ao dono de aparelho novo** (Telegram privado ou e-mail). Envia
   mensagem real a pessoas: precisa de autorização antes de ligar.
5. **Passkey (Windows Hello / Face ID)** fora da Central, como segundo fator
   quando o achado for forte. PCs da Central não suportam: lá fica a senha.
6. **Corte da virada nos apps com cookie próprio** (escala, taxímetro): hoje só
   o plantoes e o portal cortam.
7. **Mesa no 2º monitor**: se a ociosidade de 30 min incomodar quem deixa a
   Mesa num monitor ao lado, um modo "painel" só leitura, sem dado nominal,
   em vez de afrouxar o tempo.

## O que não fazemos (e por quê)

- **Botão de assumir a Mesa** em outro aparelho: com ele, duas pessoas revezam no clique.
- **Bloquear por IP ou user-agent sozinho**: Central sai por um pool de IPs; celular troca de IP no 4G; user-agent é declarado.
- **Derrubar admin automaticamente**: decisão do Caio (28/09/2026); admin só é registrado.
