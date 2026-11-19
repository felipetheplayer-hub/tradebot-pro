"""Coleta pública do 1HZ100V. Datas UTC, início inclusivo, fim exclusivo."""
import argparse
import json
import time
from pathlib import Path

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from evaluate import utc

URL = 'wss://api.derivws.com/trading/v1/options/ws/public'


def collect(kind, start, end, path, symbol='1HZ100V'):
    cursor = end - 1
    if path.exists():
        raise ValueError('Escolha um arquivo novo para este intervalo.')
    with path.open('x') as out:
        retries = 0
        while cursor >= start:
            try:
                with connect(URL, open_timeout=20, close_timeout=3) as socket:
                    while cursor >= start:
                        request = dict(ticks_history=symbol, end=str(cursor), count=1000, style=kind, req_id=1)
                        if kind == 'candles':
                            request['granularity'] = 60
                        else:
                            request['start'] = max(start, cursor - 999)
                        socket.send(json.dumps(request))
                        data = json.loads(socket.recv(timeout=25))
                        if data.get('error', {}).get('code') == 'RateLimit':
                            raise TimeoutError('Limite temporário da Deriv')
                        if data.get('error') or data.get('req_id') != 1:
                            raise ValueError(f'Resposta inválida para {cursor}: {data.get("error")}')
                        if kind == 'candles':
                            page = [b for b in data['candles'] if b['epoch'] <= cursor]
                            times = [b['epoch'] for b in page]
                        else:
                            raw = data['history']
                            page = [(t, v) for t, v in zip(raw['times'], raw['prices'], strict=True)
                                    if request['start'] <= t <= cursor]
                            times = [t for t, _ in page]
                        if not page:
                            raise ValueError(f'Histórico indisponível até {cursor}. Arquivo parcial: {path}')
                        out.write(json.dumps(page, separators=(',', ':')) + '\n')
                        out.flush()
                        cursor = min(times) - 1
                        retries = 0
                        time.sleep(.75)
            except (TimeoutError, ConnectionClosed, OSError):
                retries += 1
                if retries >= 5:
                    raise
                time.sleep(min(60, 15 * retries))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['candles', 'ticks'])
    parser.add_argument('start')
    parser.add_argument('end')
    parser.add_argument('output', type=Path)
    parser.add_argument('--symbol', choices=['1HZ100V', 'RB100'], default='1HZ100V')
    args = parser.parse_args()
    start, end = utc(args.start), utc(args.end)
    if not start < end <= time.time():
        parser.error('Use um período encerrado, com início antes do fim.')
    collect(args.kind, start, end, args.output, args.symbol)
