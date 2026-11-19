"""Avaliação offline de sinais no 1HZ100V. Entradas em UTC, uma página JSON por linha."""
import argparse
import json
import math
import random
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

DAY = 86400
RULES = ('dois_fechamentos', 'rompimento_20', 'rsi2_media200')


def utc(day):
    value = datetime.fromisoformat(day)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp())


def load_pages(path, kind):
    records = {}
    for line in Path(path).read_text().splitlines():
        for row in json.loads(line):
            if kind == 'candles':
                epoch = row['epoch']
                if not isinstance(epoch, int) or epoch % 60:
                    continue
                prices = tuple(row[k] for k in ('open', 'high', 'low', 'close'))
                op, high, low, close = prices
                if not all(math.isfinite(p) and p > 0 for p in prices) or not low <= min(op, close) <= max(op, close) <= high:
                    raise ValueError(f'Vela inválida em {epoch}')
                value = prices
            else:
                epoch, value = row
                if not isinstance(epoch, int) or not math.isfinite(value) or value <= 0:
                    raise ValueError('Tick inválido')
            if epoch in records and records[epoch] != value:
                raise ValueError(f'Valores diferentes para {epoch}')
            records[epoch] = value
    return records


def signals(candles):
    """Cada resultado usa apenas a vela encerrada e as anteriores, em um trecho contínuo."""
    history = deque(maxlen=200)
    prev_epoch = None
    gain = loss = 0.0
    for epoch, bar in sorted(candles.items()):
        if prev_epoch is None or epoch - prev_epoch != 60:
            history.clear()
            gain = loss = 0.0
        prev_epoch = epoch
        close = bar[3]
        directions = [0, 0, 0]
        if history:
            change = close - history[-1][3]
            directions[0] = (change > 0) - (change < 0)
            up, down = max(change, 0), max(-change, 0)
            if len(history) == 1:
                gain, loss = up, down
            else:
                gain, loss = (gain + up) / 2, (loss + down) / 2
        if len(history) >= 20:
            last20 = list(history)[-20:]
            if close > max(c[1] for c in last20):
                directions[1] = 1
            elif close < min(c[2] for c in last20):
                directions[1] = -1
        history.append(bar)
        if len(history) == 200 and gain + loss > 0:
            average = sum(c[3] for c in history) / 200
            rsi = 100 * gain / (gain + loss)
            if close > average and rsi < 10:
                directions[2] = 1
            elif close < average and rsi > 90:
                directions[2] = -1
        yield epoch + 60, directions


def outcomes(candles, start, end, ticks=None, delay=0):
    for entry, directions in signals(candles):
        if entry < start or entry + delay + 60 >= end:
            continue
        if ticks is None:
            if entry not in candles or entry + 60 not in candles:
                continue
            a, b = candles[entry][0], candles[entry + 60][0]
        else:
            a, b = ticks.get(entry + delay), ticks.get(entry + delay + 60)
            if a is None or b is None:
                continue
        yield entry, directions, (b > a) - (b < a)


def interval(daily, days):
    """Bootstrap de blocos diários. Intervalo marginal, sem pressupor ticks independentes."""
    if sum(daily[d][0] > 0 for d in days) < 7:
        return None
    rng = random.Random(20261118)
    samples = []
    for _ in range(3000):
        chosen = rng.choices(days, k=len(days))
        n = sum(daily[d][0] for d in chosen)
        if n:
            samples.append(sum(daily[d][1] for d in chosen) / n)
    if not samples:
        return None
    samples.sort()
    return [samples[round(q * (len(samples) - 1))] for q in (.025, .975)]


def summarize(rows, start, end, payout=.80):
    rows = list(rows)
    days = list(range(start // DAY, (end - 1) // DAY + 1))
    report = {}
    for i, key in enumerate(RULES):
        daily = defaultdict(lambda: [0, 0])
        n = wins = ties = 0
        for epoch, directions, move in rows:
            direction = directions[i]
            if direction:
                n += 1
                wins += direction == move
                ties += move == 0
                d = daily[epoch // DAY]
                d[0] += 1
                d[1] += direction == move
        losses = n - wins  # Rise/Fall estrito: preço igual não ganha.
        report[key] = dict(signals=n, wins=wins, losses=losses, equal_prices=ties,
                           accuracy=wins / n if n else None, coverage=n / len(rows) if rows else None,
                           daily_interval=interval(daily, days),
                           net_per_100=(payout * wins - losses) * 100 / n if n else None)
    return {'minutes_scored': len(rows), 'calendar_minutes': (end - start) // 60, 'rules': report}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candles', required=True)
    parser.add_argument('--ticks')
    parser.add_argument('--payout', type=float, default=.80, help='Lucro líquido hipotético por unidade arriscada')
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True, help='Data UTC exclusiva')
    parser.add_argument('--split', help='Primeiro dia reservado para validação')
    parser.add_argument('--delay', type=int, default=0, choices=range(0, 11))
    args = parser.parse_args()
    start, end = utc(args.start), utc(args.end)
    if not math.isfinite(args.payout) or args.payout <= 0:
        parser.error('Use um pagamento líquido positivo e finito')
    if start >= end or (args.delay and not args.ticks):
        parser.error('Datas inválidas ou atraso solicitado sem ticks')
    candles = load_pages(args.candles, 'candles')
    ticks = load_pages(args.ticks, 'ticks') if args.ticks else None
    spans = [('periodo', start, end)]
    if args.split:
        split = utc(args.split)
        if not start < split < end:
            parser.error('A separação deve estar dentro do período')
        spans = [('inicial', start, split), ('reservado', split, end)]
    result = {name: summarize(outcomes(candles, a, b, ticks, args.delay), a, b, args.payout) for name, a, b in spans}
    study = dict(symbol="1HZ100V", start=args.start, split=args.split, end=args.end,
                 pricing="ticks" if ticks is not None else "minute_opens", delay=args.delay,
                 payout=args.payout, breakeven=1 / (1 + args.payout), periods=result)
    print(json.dumps(study, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
