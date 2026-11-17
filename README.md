# TradeBot Pro — MVP demonstrativo

Conecta uma conta Options demo da Deriv por OAuth 2.0 com PKCE. O painel mostra o saldo demo consultado no login. A sessão dura até uma hora e fica na memória do servidor. A aplicação descarta a credencial da Deriv após consultar a conta.

A simulação histórica usa dados públicos, funciona sem login e usa créditos próprios. O simulador usa as últimas velas fechadas de um minuto do Volatility 100 (1s), com aposta fixa e pagamento hipotético. Operações reais e compras de contratos demo ficam bloqueadas.

## Rodar localmente

```bash
npm ci
npm run build
npm start
```

Acesse http://localhost:3000 para testar o painel e a simulação.

## Render e VPS

No serviço existente do Render, use o identificador OAuth da **New Deriv API** em `DERIV_APP_ID`. Registre exatamente `https://tradebot-pro.onrender.com/auth/callback` na Deriv e permita o escopo `trade`, exigido pela consulta de contas Options. O código usa esse escopo somente para a consulta das contas. Teste o login pelo endereço HTTPS do Render.

A VPS escuta apenas no endereço local. O Render recebe tráfego HTTPS pelo seu proxy e encaminha à porta indicada em `PORT`.
