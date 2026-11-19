# Quanto o TradeBot acerta no Volatility 100 (1s)?

**Estudo de 18/11/2026.** Nenhuma das três regras alcançou 50% de acerto nas últimas quatro semanas. Na cotação pública consultada em 18/11, seria necessário acertar 51,28% para cobrir as perdas. A evidência favorece medir sinais e contratos demo em paralelo antes de alterar as compras do bot.

## Base e protocolo

A API pública da Deriv forneceu 120.946 velas de um minuto do símbolo `1HZ100V` entre 26/08 e 17/11/2026, em UTC. O calendário continha 120.960 minutos. As velas anteriores ao início serviram para aquecer os indicadores. Excluímos registros fora da marca de minuto, verificamos preços OHLC, removemos duplicatas idênticas e reiniciamos indicadores após lacunas. As três regras e os parâmetros foram fixados antes de comparar os resultados. [Histórico oficial de mercado](https://developers.deriv.com/docs/data/ticks-history/)

- **Dois fechamentos.** Repete a direção da diferença entre os dois últimos fechamentos. Fechamentos iguais não geram sinal.
- **Rompimento de 20 velas.** Emite alta quando o fechamento supera a maior máxima das 20 velas anteriores, ou baixa quando rompe a menor mínima. É uma adaptação da entrada dos Turtles. O sistema original empregava dias, entrada durante o rompimento e regras próprias de saída. [Regras de Curtis Faith, capítulo 4](https://www.tradingwithrayner.com/wp-content/uploads/2014/11/OriginalTurtleRules.pdf)
- **RSI de 2 períodos com média de 200.** Emite alta acima da média móvel simples de 200 fechamentos quando o RSI de Wilder cai abaixo de 10. Emite baixa abaixo da média quando o RSI supera 90. A ideia de Larry Connors foi desenvolvida para ações e ETFs; a adaptação usa minutos e vencimento fixo. Ao divulgar *Short Term Trading Strategies That Work*, a editora do estudo relatou acerto superior a 80% para uma estratégia histórica com ETFs. Esse número se refere ao teste divulgado e não descreve a carreira do autor nem o resultado esperado neste índice. [Trecho do livro de Connors e Alvarez](https://tradingmarkets.com/recent/free_excerpt_from_short_term_trading_strategies_that_work-679104) · [Regras do RSI](https://chartschool.stockcharts.com/table-of-contents/trading-strategies-and-models/trading-strategies/rsi-2)

Oito semanas formaram a amostra inicial e quatro semanas posteriores ficaram reservadas. Todos os sinais usam velas já fechadas. O alvo principal compara a abertura seguinte com a abertura 60 segundos depois. Excluímos alvos que atravessariam a divisão dos períodos. Em Rise/Fall estrito, igualdade de entrada e saída conta como perda. O simulador antigo do painel usa abertura e fechamento de uma mesma vela e devolve a unidade no empate. Essa diferença de convenção afeta a comparação com os resultados antigos. [Especificação Rise/Fall](https://legacy-docs.deriv.com/docs/risefall)

## Resultado por regra

| Regra | Acerto inicial | Sinais reservados | Acertos | Acerto reservado | Intervalo de 95% | Cobertura | Líquido por 100 sinais a 0,95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dois fechamentos | 49,99% | 40.206 | 20.006 | 49,76% | 49,33–50,22% | 99,77% | −2,97 |
| Rompimento de 20 velas | 50,65% | 6.133 | 3.060 | 49,89% | 48,70–51,09% | 15,22% | −2,71 |
| RSI e média de 200 | 50,16% | 3.760 | 1.868 | 49,68% | 48,19–51,34% | 9,33% | −3,12 |

A cobertura usa os 40.299 minutos com sinal anterior e duas aberturas observáveis no período reservado. Sinais das três regras podem coincidir. Os intervalos são marginais, calculados com 3.000 reamostragens de dias inteiros e semente fixa. Eles refletem variação entre dias nessa amostra. O intervalo do RSI inclui o equilíbrio de 51,28%; seu resultado central ficou abaixo. Uma segunda implementação em pandas reproduziu as seis contagens de sinais e acertos.

O rompimento mostrou o maior acerto inicial e perdeu essa pequena vantagem sobre 50% na avaliação reservada. A Deriv descreve a ausência de livro de ofertas e alerta sobre padrões coincidentes nesses índices. Bailey e coautores mostram como testar muitas combinações no mesmo histórico aumenta a chance de escolher uma estratégia que perde desempenho em dados novos. Cada mudança futura de parâmetros precisa de uma **nova** janela de avaliação. [Perguntas frequentes da Deriv](https://deriv.com/markets/derived-indices/synthetic-indices) · [Bailey et al., The Probability of Backtest Overfitting](https://doi.org/10.21314/JCF.2016.322)

## O preço do contrato muda a exigência

Às 19h22 de Brasília, em 18/11/2026, a consulta pública de proposta para Alta e Baixa por um minuto retornou preço de US$ 1,00 e pagamento total de US$ 1,95 nas duas direções. Uma vitória renderia US$ 0,95 líquido. Essas cotações descrevem aquele instante. O estudo aplica o mesmo valor a todo o passado como cenário de sensibilidade. Os dados históricos de velas não trazem os pagamentos que teriam sido oferecidos em cada minuto. [API de propostas da Deriv](https://developers.deriv.com/docs/trading/proposal/)

| Lucro se acertar, por 1 arriscado | Acerto de equilíbrio | Líquido da regra atual por 100 sinais reservados |
|---|---:|---:|
| 0,80 | 55,56% | −10,43 |
| 0,88 | 53,19% | −6,45 |
| 0,95 | 51,28% | −2,97 |

Com perda integral por erro, o equilíbrio é `1 / (1 + lucro por acerto)`. A conta por 100 sinais considera entrada unitária e todos os sinais elegíveis. Limites por sessão, saldo, tempo de confirmação, rejeições e contratos ainda abertos alteram quais ordens o bot efetivamente executaria.

## O relógio também altera o rótulo de acerto

Em um período posterior, de 06h a 18h UTC em 18/11, obtivemos 43.199 ticks de 43.200 segundos possíveis. Comparamos preços registrados no segundo exato da entrada e 60 segundos depois, deslocando ambas as pontas. Excluímos pares incompletos e contratos que alcançariam o fim exclusivo da janela. A direção do sinal permaneceu fixa. Uma Digital Option usa o próximo tick após o processamento pelo servidor. Os deslocamentos são aproximações. [Termos de negociação da Deriv, seção 2.2.3](https://docs.deriv.com/tnc/trading-terms.pdf)

| Atraso | Dois fechamentos | Rompimento de 20 | RSI e média de 200 |
|---|---:|---:|---:|
| 0 s | 355/718 (49,44%) | 54/113 (47,79%) | 36/72 (50,00%) |
| 5 s | 351/718 (48,89%) | 56/113 (49,56%) | 35/72 (48,61%) |
| 10 s | 339/718 (47,21%) | 56/113 (49,56%) | 33/72 (45,83%) |

Entre zero e dez segundos, o sentido do movimento, incluindo empates, mudou em **141 dos 718** sinais da regra atual. Doze horas são insuficientes para concluir que todo atraso piora o desempenho. Esse resultado explica por que o painel mostra o atraso efetivamente observado nos contratos que têm auditoria.

## Como reproduzir

Use Python 3.10+ e, somente para a coleta por WebSocket, o pacote `websockets>=15,<17`. O avaliador e seus testes usam a biblioteca padrão. Os comandos abaixo pressupõem a raiz do repositório e um diretório `data/` para guardar os dados. O coletor recusa sobrescrever arquivos existentes. A disponibilidade de ticks antigos depende da retenção que a Deriv aplicar à consulta.

```sh
mkdir -p data
python3 -m pip install 'websockets>=15,<17'
python3 research/collect.py candles 2026-08-25T20:00 2026-11-18 data/candles.jsonl
python3 research/evaluate.py --candles data/candles.jsonl --start 2026-08-26 --split 2026-10-21 --end 2026-11-18 --payout .95
python3 research/collect.py candles 2026-11-18T02:00 2026-11-18T18:00 data/timing-candles.jsonl
python3 research/collect.py ticks 2026-11-18T06:00 2026-11-18T18:00 data/ticks.jsonl
python3 research/evaluate.py --candles data/timing-candles.jsonl --ticks data/ticks.jsonl --start 2026-11-18T06:00 --end 2026-11-18T18:00 --delay 5 --payout .95
python3 -m unittest discover -s research
```

Os resultados completos das duas amostras estão em [estudo-1m.json](../public/estudo-1m.json). Para testar outro pagamento, altere `--payout`. Para repetir a análise do relógio, use `--delay 0`, `5` e `10`. A próxima validação relevante é prospectiva, com sinais anotados antes do vencimento, preços e pagamentos observados e comparação com a liquidação demo.
