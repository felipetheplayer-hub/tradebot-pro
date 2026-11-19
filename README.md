# TradeBot Pro — execução exclusivamente demo

Conecta contas Options demo pela New Deriv API com OAuth 2.0, PKCE S256 e validação de state. Contas reais são sempre bloqueadas. A simulação histórica continua disponível sem login, com créditos separados.

## Executar e testar

Node.js 22.16 ou superior (validado com Node 24). Execute `npm ci`, `npm test` e `npm start`. O painel local fica em http://127.0.0.1:3000. Login e ações autenticadas usam exclusivamente o HTTPS existente: https://tradebot-pro.onrender.com. O callback cadastrado permanece https://tradebot-pro.onrender.com/auth/callback e o OAuth requer o escopo `trade`.

## Habilitação no servidor

### Arquitetura ativa: execução na VPS

O processo da VPS é o dono do OAuth, das sessões, dos WebSockets e do histórico. O Render apenas encaminha as requisições ao endereço HTTPS da VPS em `TRADEBOT_UPSTREAM_BASE`, autenticando com `TRADEBOT_BRIDGE_KEY`. Na VPS configure a mesma chave, sem `TRADEBOT_UPSTREAM_BASE`, para bloquear o acesso sem autenticação entre servidores. Nenhuma credencial da Deriv é persistida no Render. Cookies continuam pertencendo ao domínio HTTPS do painel, e o callback registrado não muda.

O nginx encaminha `/tradebot-upstream/` ao processo local em `127.0.0.1:3100`. A rota exige a chave do backend, desativa logs de acesso para não registrar códigos OAuth e mantém os sites existentes. Não registre chaves em URLs. O banco fica em `/var/lib/tradebot-pro`, sob usuário de serviço dedicado. Backups da instalação e configuração anteriores devem existir antes de trocar a versão. O Render pode permanecer no plano gratuito: não há execução nem banco nele.

### Alternativa: execução direta no Render (não utilizada)

Por padrão `DEMO_EXECUTION_ENABLED=false`. Para habilitar, configure `DERIV_APP_ID`, `DEMO_EXECUTION_ENABLED=true` e armazenamento persistente em `TRADEBOT_DATA_DIR`. No Render a execução continua bloqueada sem um diretório explicitamente configurado. Esse diretório precisa corresponder a um disco persistente realmente montado; definir a variável não cria o disco. O filesystem comum do Render não garante histórico após restart/redeploy. Use uma única instância, sem bancos separados e sem SQLite sobre filesystem de rede.

O arquivo `demo.sqlite` mantém intenções de compra, contratos, liquidações e limites, com commits síncronos e lock exclusivo durante a vida do processo. Uma segunda conexão ao mesmo banco não pode operar simultaneamente. Mantenha os dados fora do Git, faça backup com o serviço parado e restrinja o diretório ao usuário do serviço. No Render, disco persistente e eventual mudança de plano dependem da configuração e do custo apresentados pela plataforma. A VPS permanece em `127.0.0.1:3100`, sem nova porta pública.

Após habilitar a versão nova, reconecte a conta demo: sessões antigas não contêm credenciais de execução. O token OAuth passa a permanecer somente na memória do servidor, por até uma hora e limitado à sua validade. Não há tokens no banco, navegador ou logs. Logout e expiração removem a sessão e interrompem novas compras. Reinícios exigem novo login e início manual, sem retomada automática.

## Execução demo

- Estratégia padrão no `1HZ100V`, contratos `CALL`/`PUT` de um minuto, sem martingale. O sinal compara dois fechamentos consecutivos de velas de um minuto. O bot aguarda a próxima vela após o início e só aceita sinais até dez segundos após o fechamento. Empates, lacunas e dados antigos não geram compra.
- O modo demo experimental de retorno ao limite escolhe o `RB100` no servidor. Alta exige fechamento exatamente na mínima das 60 velas anteriores e ao menos duas dessas velas com a mesma mínima. Baixa exige as condições simétricas na máxima. As 61 velas precisam ser fechadas e consecutivas. Cotação com pagamento total inferior a 1,90 vez o preço da entrada, pagamento ausente ou sinal com mais de cinco segundos bloqueiam a compra. O prazo se refere ao envio local. Preço de entrada, pagamento final e liquidação dependem da corretora. A simulação histórica antiga continua usando o Volatility 100.
- A execução usa cotação e pagamento da Deriv, com entrada após o sinal e duração de um minuto a partir da compra. Não reproduz exatamente a entrada na abertura e o pagamento hipotético de 0,80 do simulador.
- Uma execução por conta e um contrato por vez. Valor entre 0,35 e 10,00 na moeda da conta; perda líquida máxima até 50,00; de 1 a 20 operações; duração máxima de 20 minutos. Os padrões 1,00 / 3,00 / 3 operações são limites de teste. Mínimos de contrato dependem da Deriv; rejeições interrompem a execução.
- Antes de comprar, verifica saldo e se perder o valor integral da próxima operação ultrapassaria a perda líquida máxima daquela execução. Iniciar novamente não reinicializa uma execução ativa. Parar impede novas compras e acompanha o contrato comprado até a liquidação. Logout/expiração podem interromper o acompanhamento; use Verificar pendências após reconectar.
- A identidade vem somente da lista autenticada de contas demo ativas, com identificador `DOT...`. O endereço OTP precisa usar o host oficial, WSS e o caminho `/trading/v1/options/ws/demo`. Redirecionamentos são proibidos. O saldo deve pertencer à mesma conta e moeda.
- A intenção é gravada antes do envio. Em timeout/desconexão após envio, a compra nunca é repetida. Intenções sem recibo permanecem pendentes e bloqueiam novos inícios, inclusive após reinício. Rejeições explícitas não contam como contratos abertos. Falhas de gravação impedem compras.
- Verificar pendências é somente leitura: consulta contratos conhecidos e registra liquidações. Compras sem identificador exigem conferência do extrato Deriv e reconciliação administrativa; esta versão não apaga nem resolve a incerteza automaticamente.
- O painel mostra até 100 registros recentes da conta autenticada. O saldo principal continua sendo o consultado no login. Credenciais e IDs brutos de conta não são persistidos; um hash estável separa as contas no banco.

`POST /api/start`, `/api/stop` e `/api/reconcile` exigem sessão válida e Origin HTTPS exata. O navegador nunca envia parâmetros de contrato ou identificadores de conta. Cookies seguem `Secure`, `HttpOnly` e `SameSite=Lax`. Nenhuma rota aceita conta real, compra arbitrária ou símbolos fornecidos pelo navegador.

## Validação

`npm test` cobre isolamento de sessões/contas, Origin, rejeição de contas reais, limites, concorrência, parada durante cotação, logout, expiração, dados antigos, saldo insuficiente, timeout de compra, rejeição explícita, persistência, exclusão mútua do banco e reconciliação após reinício. As compras dos testes usam corretora simulada, sem ordens à Deriv.

Referências: [OTP e canal demo](https://developers.deriv.com/docs/options/websocket/), [schemas oficiais](https://github.com/deriv-com/deriv-api-schemas), [compra de contrato](https://developers.deriv.com/docs/trading/buy/). A API V2 usa `underlying_symbol`; IDs de cotações unárias são informativos, por isso a compra usa `buy: "1"`, os mesmos parâmetros e um teto de preço.

## Multiplicadores RB100 em demo

A estratégia `range_multiplier` usa a mesma condição de retorno ao limite e contrata MULTUP/MULTDOWN com o menor multiplicador aprovado na conta, até 400. As propostas devem confirmar stop-loss de 50% da entrada e take-profit igual à entrada. O valor mínimo é 1,00 na moeda da conta. As propostas são consultadas na conta demo. Uma divergência entre catálogo e validação da cotação só permite repetir a consulta com o menor multiplicador explicitamente aceito pela API, limitado a 400.

O motor solicita a venda após 60 segundos da confirmação da compra. Stop-loss e take-profit ficam no contrato da Deriv. Parada ou expiração da sessão solicitam o fechamento do multiplicador existente enquanto a conexão estiver disponível. Reinícios exigem reconectar e verificar pendências para consultar e encerrar contratos conhecidos cujo prazo já passou. Uma compra sem recibo continua bloqueando novas compras.

O botão de teste técnico envia uma única compra demo de Alta de 1,00 virtual, com os mesmos limites. O histórico identifica o teste. A análise de desempenho apresenta multiplicadores separadamente e exclui compras de teste técnico. O desempenho histórico direcional do estudo exige nova validação financeira com esses contratos.
