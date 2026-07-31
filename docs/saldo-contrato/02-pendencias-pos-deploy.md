# O que o admin precisa fazer na tela depois do deploy

> Levantado no LAB (cópia do banco de produção) em 2026-07-31, com a planilha
> `2026 CHAMAMENTO 004-2.xlsx`. As listas nominais são regeneradas pelo relatório do
> backfill na hora da carga em produção — os números aqui são a fotografia de agora.

O backfill carrega **129 saldos** automaticamente. O que sobra está agrupado abaixo por
motivo, do mais urgente para o que não precisa de nada.

---

## A. Contrato criado, saldo em branco — 3 médicos

Aparecem na tela com o campo de saldo destacado e vazio. É só digitar.

| Médico | Contrato | Por que ficou em branco |
|---|---|---|
| Gabriel Vitor do Amor Divino de Jesus | 093/2026 | A planilha abriu o contrato em R$ 0,00 e foi acumulando o consumo com sinal negativo. O −27.368,34 que ela mostra é **consumo, não saldo** — ele não estourou, só nunca teve o teto cadastrado. |
| João Pedro Miguez Pinto | 219/2025 | Mesma coisa: −25.277,89 é consumo acumulado. |
| Leonardo Copque Magalhães | 247/2025 | Contrato encerrado no negativo e substituído pelo 184/2026, que entrou normal. Este aqui é o antigo; o chefe decide se encerra ou zera. |

---

## B. Estão na planilha mas sem data de admissão — 3 médicos

Sem a data não dá para saber quando o ciclo começa, e sem ciclo não há como projetar nada.
**O contrato nem é criado.** O admin cadastra contrato + janela do ciclo + saldo.

Os três estão produzindo, então isso não pode ficar para depois:

| Médico | Produção abr–jul/2026 |
|---|---:|
| Stephane Izabor de Oliveira Costa | R$ 20.171,58 |
| Thiago Borghi Petrus Costa | R$ 18.309,13 |
| Vinicius Pereira de Carvalho | R$ 5.534,23 |

---

## C. Ativos e produzindo, fora da planilha — 7 médicos

Contratados depois do corte da planilha, provavelmente. Estão plantonando e sendo pagos,
mas não têm contrato nenhum no sistema. Precisam de cadastro completo.

| Médico | Produção abr–jul/2026 |
|---|---:|
| Lucyane Santana Teixeira | R$ 29.158,13 |
| Giulia Santos dos Reis Souza | R$ 17.136,92 |
| Gabriela Alves Costa | R$ 10.912,57 |
| Isabella Pereira da Nóbrega | R$ 5.388,17 |
| Antonio Elcio Santos Silva | R$ 5.115,71 |
| Larissa Osthues Revert Silva | R$ 2.762,20 |
| Victor Vilas Boas Mangabeira | R$ 2.625,97 |

---

## D. Estatutários — 36 médicos, nada a fazer

Pagos fora deste sistema (`employmentType = estatutario`, valor devido zero). Não têm teto
de contrato PJ e **não devem** receber saldo. Se aparecerem pedindo cadastro na tela, é
sinal de que o `employmentType` deles está errado no cadastro, não de que falta contrato.

Alessandra Correia de Almeida · Alexsandra dos Santos Vasconcelos · Bruno Oliveira Pedreira ·
Claudio Azoubel Filho · Cloud Kennedy Couto Sá · Diego Antonio de Melo Mascarenhas ·
Diogo Laercio Reis de Andrade Melo · Edberig Almeida de Araujo · Elisabeth Martinez Fonseca ·
Fernando Dias Costa Bandeira Filho · Fred Anderson Pacheco dos Santos · Glauce Bittencourt da Silva ·
Helioson Hezalio Pereira dos Santos · Igor Cerqueira de Freitas Barreto · Jean Rios Novaes Silva ·
José Roberto de Oliveira Sousa · João Matheus Dantas de Almeida · João Paulo Almeida Silva ·
Leonardo Freitas Lopes · Leticia Vitor de Andrade Santos · Lucas Fernandes da Silva ·
Lucas Rocha Dias de Albuquerque · Lucio Alvarez Parada de Carvalho · Malcon Lins da Silva ·
Manuella Klaisy Assis Barreto · Marcela Embiruçu Carvalho · Maria Auxiliadora Dantas de Almeida ·
Oswaldo Alves Bastos Neto · Pedro Henrique Oliveira Silva · Pollianna de Souza Roriz ·
Reinaldo Santos Leal · Rhanniel T. H. Oliveira S. Gomes Villar · Ronaldo Henrique Acacio de Souza ·
Tiago Almeida de Sousa · Viviane Alves e Alves · Yhokenn Karlo Nunes Beserra

---

## E. PJ sem produção no período — 10, verificar se ainda estão ativos

Marcados como ativos em `doctors`, sem contrato e sem nenhum plantão pagável entre abril e
julho de 2026. Provavelmente saíram e ninguém desmarcou. Não precisam de saldo; precisam de
uma conferência do cadastro.

Gabriel Ribeiro Sampaio Cruz · João Gustavo dos Anjos Morais Oliveira · Leonardo Rios Carteado ·
Luiza Lessa Soares · Marcio La Torre Pina · Maria Fernanda Souza Uzeda da Silva ·
Mariana Almeida Maynart Aires · Oswaldo Alves Bastos Neves · Rafael Marcelino Oliveira

`Admin Sistema` também aparece aqui — é a conta de admin, não um médico.

---

## Resumo

| Grupo | Quantos | Ação |
|---|---:|---|
| A — saldo em branco | 3 | digitar o saldo |
| B — sem data de admissão | 3 | cadastrar contrato + ciclo + saldo |
| C — fora da planilha, produzindo | 7 | cadastrar contrato + ciclo + saldo |
| D — estatutários | 36 | nenhuma |
| E — PJ sem produção | 10 | conferir se ainda estão ativos |

**Trabalho real do admin: 13 médicos** (A + B + C). Os grupos B e C são os que doem, porque
são médicos plantonando hoje sem nenhum controle de teto.

## Correções já aplicadas pelo backfill

Cinco saldos entram corrigidos, não como estão na planilha. Derivação completa em
[`saldo-overrides.json`](saldo-overrides.json) e em [`01-conferencia-2025.md`](01-conferencia-2025.md).

| Médico | Planilha | Entra como |
|---|---:|---:|
| Karen Seifarth Miranda | −89.762,24 | **−6.896,24** |
| Karla Santos Pinto | 275.482,45 | **284.605,23** |
| Renê Requião Paim | 101.853,74 | **137.391,25** |
| Acacio Junio de Almeida | 11.931,84 | **140.834,60** |
| Venandra Ribeiro e Andrade | 173.670,94 | **168.691,46** |
