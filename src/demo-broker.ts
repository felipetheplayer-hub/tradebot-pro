import WebSocket from 'ws';

export type DemoIdentity = { id: string; currency: string; token: string };
export type Direction = 'CALL' | 'PUT';
export type DemoSymbol = '1HZ100V' | 'RB100';
export type ContractAudit = {
  underlying_symbol?: string; contract_type?: string; currency?: string;
  buy_price?: number; payout?: number; sell_price?: number;
  date_start?: number; date_expiry?: number; sell_time?: number;
  entry_spot?: number; entry_spot_time?: number; exit_spot?: number; exit_spot_time?: number;
};
export type Contract = { id: number; sold: boolean; profit: number | null; audit?: ContractAudit };

// Whitelist only contract facts. Never persist raw messages, echo_req, tokens or OTP URLs.
export function contractAudit(contract: Record<string, unknown>): ContractAudit {
  const audit: Record<string, string | number> = {};
  for (const key of ['underlying_symbol', 'contract_type', 'currency']) {
    const value = contract[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value)) audit[key] = value;
  }
  for (const key of ['buy_price', 'payout', 'sell_price', 'date_start', 'date_expiry', 'sell_time',
    'entry_spot', 'entry_spot_time', 'exit_spot', 'exit_spot_time']) {
    const raw = contract[key];
    const value = typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    if (typeof value === 'number' && Number.isFinite(value)) audit[key] = value;
  }
  return audit as ContractAudit;
}
export interface Broker {
  balance(): Promise<number>;
  quote(direction: Direction, stake: number, symbol?: DemoSymbol): Promise<{ price: number; payout?: number; parameters: Record<string, unknown> }>;
  buy(quote: { price: number; parameters: Record<string, unknown> }): Promise<number>;
  contract(id: number): Promise<Contract>;
  close(): void;
}

export class BrokerError extends Error {
  constructor(public readonly code: 'rejected' | 'unavailable' | 'invalid', public readonly apiCode?: string) {
    super('A conexão demo não pôde concluir a solicitação.');
  }
}

export class RangeDurationError extends BrokerError {
  constructor(public readonly detail: string) {
    super('rejected', 'TradingDurationNotAllowed');
  }
}

function rangeCatalogDescription(data: unknown): string {
  if (!Array.isArray(data)) return 'O catálogo da conta não pôde ser consultado.';
  const options = new Set<string>();
  for (const row of data) {
    if (row?.underlying_symbol !== 'RB100' || !/^[A-Z0-9_]{1,24}$/.test(row.contract_type ?? '')) continue;
    const type = String(row.contract_type);
    const min = String(row.min_contract_duration ?? ''), max = String(row.max_contract_duration ?? '');
    const timed = ['CALL', 'PUT'].includes(type) && /^\d{1,8}[smhdt]$/.test(min) && /^\d{1,8}[smhdt]$/.test(max);
    options.add(timed ? type + ' (' + min + ' a ' + max + ')' : type);
  }
  return options.size ? 'Contratos listados para RB100 nesta conexão: ' + [...options].join(', ') + '.' :
    'A consulta não retornou contratos para RB100.';
}

export function validateDemoUrl(value: unknown) {
  if (typeof value !== 'string') throw new BrokerError('invalid');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.hostname !== 'api.derivws.com' || url.port ||
      url.username || url.password || url.hash ||
      url.pathname !== '/trading/v1/options/ws/demo' || !url.searchParams.get('otp') ||
      [...url.searchParams.keys()].some(key => key !== 'otp')) throw new BrokerError('invalid');
  return url.href;
}

// Credentials and the OTP URL stay in server memory. Never log transport errors or echo_req.
export async function openDemoBroker(identity: DemoIdentity, appId: string, fetcher = fetch,
  socketFactory = (url: string) => new WebSocket(url, {
    handshakeTimeout: 8000, maxPayload: 512 * 1024, followRedirects: false,
  })): Promise<Broker> {
  if (!/^DOT\d{1,10}$/.test(identity.id)) throw new BrokerError('invalid');
  const response = await fetcher(
    'https://api.derivws.com/trading/v1/options/accounts/' + identity.id + '/otp', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bearer ' + identity.token, 'Deriv-App-ID': appId },
    });
  if (!response.ok) throw new BrokerError('unavailable');
  const result = await response.json();
  const socket = socketFactory(validateDemoUrl(result?.data?.url));
  let sequence = 0;
  const pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let heartbeat: NodeJS.Timeout | undefined;
  function failAll() {
    clearInterval(heartbeat);
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new BrokerError('unavailable'));
    }
    pending.clear();
  }
  socket.on('error', failAll);
  socket.on('close', failAll);
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      const request = pending.get(message.req_id);
      if (!request) return;
      pending.delete(message.req_id);
      clearTimeout(request.timer);
      if (message.error) {
        const apiCode = typeof message.error.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(message.error.code)
          ? message.error.code : undefined;
        request.reject(new BrokerError('rejected', apiCode));
      }
      else request.resolve(message);
    } catch { socket.terminate(); failAll(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new BrokerError('unavailable')); }, 8500);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new BrokerError('unavailable')); });
      socket.once('close', () => { clearTimeout(timer); reject(new BrokerError('unavailable')); });
    });
  } catch { socket.terminate(); throw new BrokerError('unavailable'); }

  function request(data: Record<string, unknown>): Promise<any> {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new BrokerError('unavailable'));
    const req_id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req_id);
        reject(new BrokerError('unavailable'));
      }, 8000);
      pending.set(req_id, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...data, req_id }), error => {
        if (error) { socket.terminate(); failAll(); }
      });
    });
  }
  // Sparse RB100 signals can leave the authenticated connection idle for minutes.
  heartbeat = setInterval(() => {
    void request({ ping: 1 }).catch(() => { socket.terminate(); failAll(); });
  }, 30_000);
  heartbeat.unref();
  const rangeSeconds = new Set<Direction>();
  return {
    async balance() {
      const { balance } = await request({ balance: 1 });
      if (balance?.loginid !== identity.id || balance.currency !== identity.currency ||
          typeof balance.balance !== 'number' || !Number.isFinite(balance.balance) || balance.balance < 0) {
        throw new BrokerError('invalid');
      }
      return balance.balance;
    },
    async quote(direction, stake, symbol = '1HZ100V') {
      if (symbol !== '1HZ100V' && symbol !== 'RB100') throw new BrokerError('invalid');
      const parameters = {
        amount: stake, basis: 'stake', contract_type: direction, currency: identity.currency,
        duration: 1, duration_unit: 'm', underlying_symbol: symbol,
      };
      const range = symbol === 'RB100';
      if (range && rangeSeconds.has(direction)) {
        parameters.duration = 60;
        parameters.duration_unit = 's';
      }
      const getPrice = () => request({ proposal: 1, ...parameters });
      let response;
      try {
        response = await getPrice();
      } catch (err) {
        if (!range || !(err instanceof BrokerError) || err.apiCode !== 'TradingDurationNotAllowed') throw err;
        const useSeconds = parameters.duration_unit === 'm';
        parameters.duration = useSeconds ? 60 : 1;
        parameters.duration_unit = useSeconds ? 's' : 'm';
        try {
          response = await getPrice();
          if (useSeconds) rangeSeconds.add(direction);
          else rangeSeconds.delete(direction);
        } catch (retryError) {
          if (!(retryError instanceof BrokerError) || retryError.apiCode !== 'TradingDurationNotAllowed') throw retryError;
          const catalog = await request({ contracts_for: symbol }).catch(() => undefined);
          throw new RangeDurationError(rangeCatalogDescription(catalog?.contracts_for?.available));
        }
      }
      const { proposal } = response;
      if (typeof proposal?.ask_price !== 'number' || !Number.isFinite(proposal.ask_price) ||
          proposal.ask_price <= 0 || proposal.ask_price > stake) throw new BrokerError('invalid');
      return { price: proposal.ask_price, payout: proposal.payout, parameters };
    },
    async buy(quote) {
      // V2 unary proposal IDs are informational. Buy using the same parameters and a price ceiling.
      const { buy } = await request({ buy: '1', price: quote.price, parameters: quote.parameters });
      if (!Number.isSafeInteger(buy?.contract_id) || buy.contract_id <= 0) throw new BrokerError('invalid');
      return buy.contract_id;
    },
    async contract(id) {
      const { proposal_open_contract: contract } = await request({ proposal_open_contract: 1, contract_id: id });
      const sold = contract?.is_sold === 1;
      const profit = typeof contract?.profit === 'number' ? contract.profit :
        typeof contract?.profit === 'string' && /^-?\d+(\.\d+)?$/.test(contract.profit) ? Number(contract.profit) : NaN;
      if (contract?.contract_id !== id || ![0, 1].includes(contract?.is_sold) ||
          (sold && !Number.isFinite(profit))) throw new BrokerError('invalid');
      const audit = contractAudit(contract);
      return { id, sold, profit: sold ? profit : null, ...(Object.keys(audit).length ? { audit } : {}) };
    },
    close() { socket.terminate(); failAll(); },
  };
}
