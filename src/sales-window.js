import { AppError } from './config.js';

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function salesWindow(config, now = new Date(), mode = config.mode) {
  const { initialDate, lookbackDays, timeZone } = config.sales;
  if (!initialDate) throw new AppError(503, 'INITIAL_DATE_PENDING', 'Configure sales.initialDate antes de consultar vendas.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const rollingStart = addDays(today, -lookbackDays);
  const start = mode === 1 ? initialDate : (initialDate > rollingStart ? initialDate : rollingStart);
  // Timestamp upper bound is exclusive: include all of today, even fractional seconds.
  return { start: `${start} 00:00:00`, endExclusive: `${addDays(today, 1)} 00:00:00`, timeZone };
}

export function withinWindow(rows, window) {
  return rows.filter(row => row.pedido_data_venda >= window.start && row.pedido_data_venda < window.endExclusive);
}

export function intersectFilters(filters, window) {
  const end = `${addDays(window.endExclusive.slice(0, 10), -1)} 23:59:59`;
  return { ...filters, start: !filters.start || filters.start < window.start ? window.start : filters.start,
    end: !filters.end || filters.end > end ? end : filters.end };
}

export function directQueryWindow(filters, window) {
  const end = new Date(`${filters.end.replace(' ', 'T')}Z`);
  end.setUTCSeconds(end.getUTCSeconds() + 1);
  return { ...window, start: filters.start, endExclusive: end.toISOString().slice(0, 19).replace('T', ' ') };
}

export function defaultDirectStart(filters, window) {
  if (filters.start) return filters;
  const today = addDays(window.endExclusive.slice(0, 10), -1);
  return { ...filters, start: `${today} 00:00:00` };
}

export function assertDirectStart(filters, config) {
  const minimum = `${config.sales.initialDate} 00:00:00`;
  if (filters.start && filters.start < minimum) {
    throw new AppError(400, 'DATE_BEFORE_INITIAL', `date_start nao pode ser anterior a ${config.sales.initialDate}.`);
  }
}

export function assertSnapshotWindow(snapshot, config) {
  const expected = salesWindow(config, new Date(snapshot.extractedAt), 2);
  const received = snapshot.salesWindow;
  if (!received || received.start !== expected.start || received.endExclusive !== expected.endExclusive || received.timeZone !== expected.timeZone) {
    throw new AppError(422, 'WINDOW_MISMATCH', 'Janela do snapshot difere da configuracao. Atualize o JSON no Windows e sincronize novamente.');
  }
}

export function assertCoverage(snapshot, window) {
  const covered = snapshot.salesWindow;
  if (!covered || covered.timeZone !== window.timeZone || covered.start > window.start || covered.endExclusive < window.endExclusive) {
    throw new AppError(503, 'CACHE_WINDOW_STALE', 'Cache nao cobre a janela atual. Execute a sincronizacao no Windows.');
  }
}
