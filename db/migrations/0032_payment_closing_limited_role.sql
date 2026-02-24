-- Permite uma role de fechamento com acesso restrito ao payment-closing.
-- Essa role pode apenas visualizar a tela e salvar NF/processo.
-- Ações de criar/remover plantões, banco de horas, contrato e atestação
-- seguem bloqueadas por endpoint (admin-only).

alter type operations_v2.user_role
    add value if not exists 'payment_closing_limited';
