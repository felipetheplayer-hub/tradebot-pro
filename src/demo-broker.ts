import WebSocket from 'ws';

export type DemoIdentity = { id: string; currency: string; token: string };
export type Direction = 'CALL' | 'PUT';
export type Contract = { id: number; sold: boolean; profit: number | null };
export interface Broker {
  balance(): Promise<number>;
  quote(direction: Direction, stake: number): Promise<{ price: number; parameters: Record<string, unknown> }>;
  buy(quote: { price: number; parameters: Record<string, unknown> }): Promise<number>;
  contract(id: number): Promise<Contract>;
  close(): void;
}

export class BrokerError extends Error {
  constructor(public readonly code: 'rejected' | 'unavailable' | 'invalid') {
    super('A conexão demo não pôde concluir a solicitação.');
  }
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
  function failAll() {
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
      if (message.error) request.reject(new BrokerError('rejected'));
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
  return {
    async balance() {
      const { balance } = await request({ balance: 1 });
      if (balance?.loginid !== identity.id || balance.currency !== identity.currency ||
          typeof balance.balance !== 'number' || !Number.isFinite(balance.balance) || balance.balance < 0) {
        throw new BrokerError('invalid');
      }
      return balance.balance;
    },
    async quote(direction, stake) {
      const parameters = {
        amount: stake, basis: 'stake', contract_type: direction, currency: identity.currency,
        duration: 1, duration_unit: 'm', underlying_symbol: '1HZ100V',
      };
      const { proposal } = await request({ proposal: 1, ...parameters });
      if (typeof proposal?.ask_price !== 'number' || !Number.isFinite(proposal.ask_price) ||
          proposal.ask_price <= 0 || proposal.ask_price > stake) throw new BrokerError('invalid');
      return { price: proposal.ask_price, parameters };
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
      return { id, sold, profit: sold ? profit : null };
    },
    close() { socket.terminate(); failAll(); },
  };
}
