# Git hooks deste repo

`pre-push` bloqueia só **force-push** em `main` (reescrever o histórico apaga a
auditoria de deploy). Push direto na `main` é permitido desde 29/09/2026: todo
push/merge na `main` vai ao LIVE pelo `release-deploy.yml`, sem exigir PR. No
GitHub, o ruleset do repo também barra force-push e deleção de branch.

## Opcional

O ruleset do GitHub já barra force-push no servidor, então o hook é redundante
e fica **desligado** no clone do Caio desde 29/09/2026. Para religar num clone:

```bash
git config core.hooksPath .githooks
```
