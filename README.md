# TradeBot Pro — MVP demonstrativo

Painel web responsivo e backend Node.js/TypeScript para conectar **somente uma conta virtual** da Deriv. Não executa compras ou vendas nesta versão. A API bloqueia contas reais mesmo que um token real seja fornecido por engano.

## Rodar localmente

```bash
npm install
cp .env.example .env
npm run dev
```

Abra http://localhost:3000. Para conectar, preencha `DERIV_APP_ID` e `DERIV_DEMO_TOKEN` no `.env` local, nunca em mensagens ou no GitHub. O token deve pertencer a uma conta virtual. Não há necessidade de habilitar a execução; `ENABLE_DEMO_TRADING` é reservado para uma futura versão.

## Render

Crie um Web Service Node ligado ao repositório, com build command `npm install && npm run build` e start command `npm start`. Defina as variáveis de ambiente no painel privado do Render. Para serviço gratuito, verifique a política atual de suspensão por inatividade; não presuma funcionamento 24h.

## Segurança e próximos passos

- OAuth 2.0 com callback HTTPS real, depois que houver domínio publicado; **não use URLs fictícias**.
- Validar endpoints e métodos de autenticação contra a documentação atual da Deriv antes de publicar.
- Implementar backtest, simulador e limites de risco antes de habilitar qualquer compra de contrato demo.
- Não usar tokens de contas reais nem operar com dinheiro real.
- Verificar restrições da CVM aplicáveis ao Brasil.
