# Fluxo Operacional Obrigatorio Para Entregas

Estas instrucoes se aplicam a todo trabalho neste repositorio.

## Regra de validacao em producao

Quando houver alteracao de UI, filtros, navegacao, rotas admin, regras de exibicao ou qualquer comportamento que o usuario vai validar em navegador:

1. O agente deve validar no host publico de teste: `plantoes.mnrs.com.br`.
2. Nao encerrar a tarefa sem informar URLs testadas e codigos HTTP retornados.
3. Sempre validar tambem o upstream local (`http://127.0.0.1:3004`) para separar problema de app vs proxy.

Checklist minimo:

```bash
curl -fsS http://127.0.0.1:3004/api/health
curl -sk -o /dev/null -w "%{http_code}\n" https://plantoes.mnrs.com.br/api/health
```

Para mudancas de tela, incluir a rota alterada no teste externo (por exemplo `https://plantoes.mnrs.com.br/admin/payment-closing`).

## Regra de comunicacao de deploy

Sempre que houver deploy/restart para publicar mudancas:

- Informar no resumo final se o deploy foi executado
- Informar status de verificacao no dominio publico
- Nao afirmar "pronto" sem evidencia minima de validacao no host publico
