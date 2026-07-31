# Backfill do saldo contratual — relatório

- Origem: `tmp-chamamento-004.xlsx`
- Modo: **--apply** (gravou no banco)
- Importa **um número por contrato**: a coluna `SALDO CONTRATO` de MAIO/2026. De junho em diante o consumo vem do fechamento assinado no próprio sistema.
- Contratos encontrados: **135**
- Saldo de abertura importado: **117**
- Saldo em branco para o coordenador digitar: **18** — renovação pendente 13 · teto não carregado 2 · célula ilegível 0 · sem ciclo 3
- Casados com `operations_v2.doctors`: **134** · não casados: **0**

## Saldo em branco — o coordenador precisa digitar

O contrato é criado sem lançamento de abertura. Chutar um número aqui seria pior que deixar o campo vazio.
A coluna "planilha mostra" está aqui só como referência do que **não** foi importado, e por quê.

| Médico | Contrato | Motivo | Planilha mostra |
|---|---|---|---:|
| ACACIO JUNIO DE ALMEIDA | 190/2025 | ciclo virou e a planilha não resetou | 11.931,84 |
| ALEXANDRE CURI QUINTEIRO | 111/2026 | ciclo virou e a planilha não resetou | 67.511,79 |
| ANDRÉ VICTOR CARDOSO CODECEIRA | 061/2026 | ciclo virou e a planilha não resetou | 138.654,92 |
| BRUNO SANTANA ALENCAR | 048/2026 | ciclo virou e a planilha não resetou | 135.329,00 |
| GABRIEL VITOR DO AMOR DIVINO DE JESUS | 093/2026 | planilha abriu em R$ 0,00: o número é consumo | -27.368,34 |
| GUSTAVO FERNANDES VIEIRA | 158/2026 | ciclo virou e a planilha não resetou | 159.507,65 |
| JOÃO PEDRO MIGUEZ PINTO | 219/2025 | planilha abriu em R$ 0,00: o número é consumo | -25.277,89 |
| LEONARDO COPQUE MAGALHÃES | 247/2025 | ciclo virou e a planilha não resetou | -33.141,77 |
| LEONARDO COPQUE MAGALHÃES | 184/2026 | ciclo virou e a planilha não resetou | 340.025,91 |
| LEONARDO PRADO FABEM | 110/2026 | ciclo virou e a planilha não resetou | 57.541,11 |
| LEONARDO SANTANA CABANELAS RIBEIRO | 80/2026 | ciclo virou e a planilha não resetou | 137.255,02 |
| MAIANA SANTOS DE OLIVEIRA CARDOSO | 085/2026 | ciclo virou e a planilha não resetou | 153.633,27 |
| MARIA CLARA COPPIETERS GUSMÃO | 157/2026 | ciclo virou e a planilha não resetou | 103.798,56 |
| STEPHANE IZABOR DE OLIVEIRA COSTA | 156/2026 | sem DATA ADMISSÃO | — |
| THIAGO BORGHI PETRUS COSTA (PSIQUIATRIA) | SEM NÚMERO | sem DATA ADMISSÃO | — |
| VINICIUS PEREIRA DE CARVALHO | SEM NÚMERO | sem DATA ADMISSÃO | — |
| VITOR LUIZ VALVERDE MARTINEZ | 079/2026 | ciclo virou e a planilha não resetou | 144.724,24 |
| YNGRA MARIA PIMENTEL NOVAIS | 188/2026 | ciclo virou e a planilha não resetou | 165.732,00 |

## Saldos negativos importados — estouro real

Encadeamento consistente nos meses lidos: o saldo negativo é real, não artefato da planilha.

| Médico | Contrato | Saldo em maio |
|---|---|---:|
| KAREN SEIFARTH MIRANDA | 518/2024 | -89.762,24 |
| FRANCISCO ISENSEE DE MACEDO | 797/2024 | -46.778,94 |
| KETHERYNNE CABRAL FERREIRA DE OLIVEIRA (psiquiatria) | 55/2025 | -18.755,73 |
| LUAN SAMPAIO EVANGELISTA SANTOS (psiquiatria) | 612/2025 | -9.098,74 |
| BRUNO MOTA (PSIQUIATRIA) | 633/2025 | -1.411,47 |

## Nomes que não casaram — sugestões para você validar

Todos os nomes da planilha casaram com um médico cadastrado.

## Aliases aplicados

Vínculos aprovados à mão em `docs/saldo-contrato/name-aliases.json` — **12**:

- BRUNO MOTA (PSIQUIATRIA) -> Bruno Mota de Almeida
- FREDERICO AFONSO FOEPPEL DIAS -> Frederico Afonso Foepel Dias
- GERARDSON MACEDO E SILVA E SOUZA -> Gerardson Macedo e Silva Souza
- GULHERME RABELO MOTA -> Guilherme Rabelo Mota
- LEONARDO PRADO FABEM -> Leonardo Prado Faben
- LILLIAN BARROS ARAUJO DOS SANTOS   (-12H) -> Lilian Barros Araujo dos Anjos
- LUANA FRANCO SOUZA BORDONI  ) -> Luana Franco Bordoni
- MAIANA SANTOS DE OLIVEIRA CARDOSO -> Maiana Santos Oliveira Cardoso
- MARCELA ARIMATEA CABRAL -> Marcela Arimateia Cabral
- SARA DE JESUS CARNEIRO SANTOS -> Sara de Jesus Carneiro
- VANESSA BRITO RAMOS  SAMU + HELIO MACHADO -> Vanessa Brito Ramos
- VENANDRA RIBEIRO E ANDRADE -> Venandra Ribeiro Andrade

## Médicos do app sem contrato — saldo em branco na tela

Ativos em `operations_v2.doctors` que a planilha de maio não cobre (contratados depois, em geral).
**Nenhum contrato foi inventado para eles**: sem nº de contrato e sem data de admissão, a janela do
ciclo seria chute. Aparecem na tela com o saldo em branco e destacado, para o admin preencher.

Total: **65**

- Admin Sistema
- Alessandra Correia de Almeida
- Alexsandra dos Santos Vasconcelos
- Antonio Elcio Santos Silva
- Bruno Mota de Almeida
- Bruno Oliveira Pedreira
- Claudio Azoubel Filho
- Cloud Kennedy Couto Sá
- Diego Antonio de Melo Mascarenhas
- Diogo Laercio Reis de Andrade Melo
- Edberig Almeida de Araujo
- Elisabeth Martinez Fonseca
- Fernando Dias Costa Bandeira Filho
- Fred Anderson Pacheco dos Santos
- Frederico Afonso Foepel Dias
- Gabriel Ribeiro Sampaio Cruz
- Gabriela Alves Costa
- Gerardson Macedo e Silva Souza
- Giulia Santos dos Reis Souza
- Glauce Bittencourt da Silva
- Guilherme Rabelo Mota
- Helioson Hezalio Pereira dos Santos
- Igor Cerqueira de Freitas Barreto
- Isabella Pereira da Nóbrega
- Jean Rios Novaes Silva
- João Gustavo dos Anjos Morais Oliveira
- João Matheus Dantas de Almeida
- João Paulo Almeida Silva
- José Roberto de Oliveira Sousa
- Larissa Osthues Revert Silva
- Leonardo Freitas Lopes
- Leonardo Prado Faben
- Leonardo Rios Carteado
- Leticia Vitor de Andrade Santos
- Lilian Barros Araujo dos Anjos
- Luana Franco Bordoni
- Lucas Fernandes da Silva
- Lucas Rocha Dias de Albuquerque
- Lucio Alvarez Parada de Carvalho
- Lucyane Santana Teixeira
- Luiza Lessa Soares
- Maiana Santos Oliveira Cardoso
- Malcon Lins da Silva
- Manuella Klaisy Assis Barreto
- Marcela Arimateia Cabral
- Marcela Embiruçu Carvalho
- Marcio La Torre Pina
- Maria Auxiliadora Dantas de Almeida
- Maria Fernanda Souza Uzeda da SIlva
- Mariana Almeida Maynart Aires
- Oswaldo Alves Bastos Neto
- Oswaldo Alves Bastos Neves
- Pedro Henrique Oliveira Silva
- Pollianna de Souza Roriz
- Rafael Marcelino Oliveira
- Reinaldo Santos Leal
- Rhanniel T. H. Oliveira S. Gomes Villar
- Ronaldo Henrique Acacio de Souza
- Sara de Jesus Carneiro
- Tiago Almeida de Sousa
- Vanessa Brito Ramos
- Venandra Ribeiro Andrade
- Victor Vilas Boas Mangabeira
- Viviane Alves e Alves
- Yhokenn Karlo Nunes Beserra

## Achados por contrato

### ACACIO JUNIO DE ALMEIDA — contrato 190/2025

Ciclo: 2026-03-18 → 2027-03-18 · teto 165.732,00

- o ciclo virou em 2026-03-18 e a planilha seguiu debitando o ciclo anterior (11931.84) — o chefe define o saldo do ciclo novo

### ALEXANDRE CURI QUINTEIRO — contrato 111/2026

Ciclo: 2026-04-09 → 2027-04-09 · teto 165.732,00

- o ciclo virou em 2026-04-09 e a planilha seguiu debitando o ciclo anterior (67511.79) — o chefe define o saldo do ciclo novo

### ANDRÉ VICTOR CARDOSO CODECEIRA — contrato 061/2026

Ciclo: 2026-03-13 → 2027-03-13 · teto 165.732,00

- o ciclo virou em 2026-03-13 e a planilha seguiu debitando o ciclo anterior (138654.92) — o chefe define o saldo do ciclo novo

### BRUNO MOTA (PSIQUIATRIA) — contrato 633/2025

Ciclo: 2025-12-23 → 2026-12-23 · teto 82.866,00

- DATA ADMISSÃO no futuro (2026-12-23) — provável erro de digitação na planilha
- saldo negativo de verdade em MAIO: -1411.47 — encadeamento consistente nos meses lidos

### BRUNO SANTANA ALENCAR — contrato 048/2026

Ciclo: 2026-03-03 → 2027-03-03 · teto 165.732,00

- o ciclo virou em 2026-03-03 e a planilha seguiu debitando o ciclo anterior (135329.00) — o chefe define o saldo do ciclo novo

### CAROLINE LUANE RABELO DA SILVA — contrato 753/2024

Ciclo: 2025-10-24 → 2026-10-24 · teto —

- CH "72" fora da tabela de referência — teto fica em branco para o coordenador preencher

### CLAUDIO HENRIQUE CAVALCANTI TEIXEIRA (psiquiatria) — contrato 562/2025

Ciclo: 2025-10-20 → 2026-10-20 · teto 82.866,00

- DATA ADMISSÃO no futuro (2026-10-20) — provável erro de digitação na planilha

### FRANCISCO ISENSEE DE MACEDO — contrato 797/2024

Ciclo: 2025-12-06 → 2026-12-06 · teto 248.598,00

- saldo negativo de verdade em MAIO: -46778.94 — encadeamento consistente nos meses lidos

### GABRIEL VITOR DO AMOR DIVINO DE JESUS — contrato 093/2026

Ciclo: 2026-03-25 → 2027-03-25 · teto 165.732,00

- a planilha abre este contrato em R$ 0,00 e acumula o consumo com sinal negativo: -27368.34 é consumo, não saldo. NÃO é estouro.

### GUSTAVO FERNANDES VIEIRA — contrato 158/2026

Ciclo: 2026-04-30 → 2027-04-30 · teto 165.732,00

- o ciclo virou em 2026-04-30 e a planilha seguiu debitando o ciclo anterior (159507.65) — o chefe define o saldo do ciclo novo

### JOÃO PEDRO DA SILVA MOREIRA (PSIQUIATRIA) — contrato 807/2024

Ciclo: 2025-11-14 → 2026-11-14 · teto 82.866,00

- DATA ADMISSÃO no futuro (2026-11-14) — provável erro de digitação na planilha

### JOÃO PEDRO MIGUEZ PINTO — contrato 219/2025

Ciclo: 2026-03-10 → 2027-03-10 · teto 165.732,00

- a planilha abre este contrato em R$ 0,00 e acumula o consumo com sinal negativo: -25277.89 é consumo, não saldo. NÃO é estouro.

### KAREN SEIFARTH MIRANDA — contrato 518/2024

Ciclo: 2025-08-16 → 2026-08-16 · teto 248.598,00

- saldo negativo de verdade em MAIO: -89762.24 — encadeamento consistente nos meses lidos

### KETHERYNNE CABRAL FERREIRA DE OLIVEIRA (psiquiatria) — contrato 55/2025

Ciclo: 2026-02-06 → 2027-02-06 · teto 82.866,00

- saldo negativo de verdade em MAIO: -18755.73 — encadeamento consistente nos meses lidos

### LEONARDO COPQUE MAGALHÃES — contrato 247/2025

Ciclo: 2026-04-04 → 2027-04-04 · teto 165.732,00

- o ciclo virou em 2026-04-04 e a planilha seguiu debitando o ciclo anterior (-33141.77) — o chefe define o saldo do ciclo novo

### LEONARDO COPQUE MAGALHÃES — contrato 184/2026

Ciclo: 2026-05-26 → 2027-05-26 · teto 174.858,00

- o ciclo virou em 2026-05-26 e a planilha seguiu debitando o ciclo anterior (340025.91) — o chefe define o saldo do ciclo novo

### LEONARDO PRADO FABEM — contrato 110/2026

Ciclo: 2026-04-10 → 2027-04-10 · teto 165.732,00

- o ciclo virou em 2026-04-10 e a planilha seguiu debitando o ciclo anterior (57541.11) — o chefe define o saldo do ciclo novo

### LEONARDO SANTANA CABANELAS RIBEIRO — contrato 80/2026

Ciclo: 2026-03-20 → 2027-03-20 · teto 165.732,00

- o ciclo virou em 2026-03-20 e a planilha seguiu debitando o ciclo anterior (137255.02) — o chefe define o saldo do ciclo novo

### LUAN SAMPAIO EVANGELISTA SANTOS (psiquiatria) — contrato 612/2025

Ciclo: 2025-12-18 → 2026-12-18 · teto 82.866,00

- DATA ADMISSÃO no futuro (2026-12-18) — provável erro de digitação na planilha
- saldo negativo de verdade em MAIO: -9098.74 — encadeamento consistente nos meses lidos

### MAIANA SANTOS DE OLIVEIRA CARDOSO — contrato 085/2026

Ciclo: 2026-03-26 → 2027-03-26 · teto 165.732,00

- o ciclo virou em 2026-03-26 e a planilha seguiu debitando o ciclo anterior (153633.27) — o chefe define o saldo do ciclo novo

### MARIA CLARA COPPIETERS GUSMÃO — contrato 157/2026

Ciclo: 2026-04-29 → 2027-04-29 · teto 165.732,00

- o ciclo virou em 2026-04-29 e a planilha seguiu debitando o ciclo anterior (103798.56) — o chefe define o saldo do ciclo novo

### SAMARA ALVES MESSIAS VIANA — contrato 618/2025

Ciclo: 2025-12-19 → 2026-12-19 · teto 165.732,00

- DATA ADMISSÃO no futuro (2026-12-19) — provável erro de digitação na planilha

### STEPHANE IZABOR DE OLIVEIRA COSTA — contrato 156/2026

Ciclo: indeterminado · teto 165.732,00

- sem DATA ADMISSÃO parseável — o coordenador precisa informar a janela do ciclo

### TAISA PASSOS DOS SANTOS MENDONÇA — contrato 639/2025

Ciclo: 2025-12-30 → 2026-12-30 · teto 165.732,00

- DATA ADMISSÃO no futuro (2026-12-30) — provável erro de digitação na planilha

### THIAGO BORGHI PETRUS COSTA (PSIQUIATRIA) — contrato SEM NÚMERO

Ciclo: indeterminado · teto 165.732,00

- sem DATA ADMISSÃO parseável — o coordenador precisa informar a janela do ciclo

### VICTOR RAMOS DA SILVA (PSIQUIATRIA) — contrato 869/2024

Ciclo: 2025-12-03 → 2026-12-03 · teto 82.866,00

- DATA ADMISSÃO no futuro (2026-12-03) — provável erro de digitação na planilha

### VINICIUS PEREIRA DE CARVALHO — contrato SEM NÚMERO

Ciclo: indeterminado · teto 82.866,00

- sem DATA ADMISSÃO parseável — o coordenador precisa informar a janela do ciclo

### VITOR LUIZ VALVERDE MARTINEZ — contrato 079/2026

Ciclo: 2026-03-20 → 2027-03-20 · teto 165.732,00

- o ciclo virou em 2026-03-20 e a planilha seguiu debitando o ciclo anterior (144724.24) — o chefe define o saldo do ciclo novo

### YNGRA MARIA PIMENTEL NOVAIS — contrato 188/2026

Ciclo: 2026-05-29 → 2027-05-29 · teto 165.732,00

- o ciclo virou em 2026-05-29 e a planilha seguiu debitando o ciclo anterior (165732.00) — o chefe define o saldo do ciclo novo

