import { AppError } from './config.js';

const userFields = ['nome', 'filial', 'filial_nome', 'filial_estado', 'filial_cidade', 'filial_regional', 'documento', 'cargo', 'responsavel'];
const saleFields = ['filial_cnpj', 'pedido_id', 'nota_numero', 'pedido_data_venda', 'vendedor', 'produto_id', 'produto_ean', 'produto_qtd', 'produto_valor', 'produto_desconto'];
const numericFields = new Set(['produto_qtd', 'produto_valor', 'produto_desconto']);
const invalid = (message) => { throw new AppError(422, 'DATA_INVALID', message); };

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const date = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19).replace('T', ' ') === value;
}

function documentMask(value, size, field) {
  // Never guess missing leading zeroes from a numeric CPF/CNPJ.
  if (typeof value !== 'string' || !/^[\d./-]+$/.test(value)) invalid(`Campo ${field} deve ser texto com CPF/CNPJ.`);
  const digits = value.replace(/\D/g, '');
  if (digits.length !== size) invalid(`Campo ${field} com tamanho invalido.`);
  return size === 11 ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

export function normalizeRows(dataset, rows, maxRows) {
  if (!['usuarios', 'vendas'].includes(dataset) || !Array.isArray(rows)) invalid('Conjunto de dados invalido.');
  if (rows.length > maxRows) throw new AppError(413, 'TOO_MANY_ROWS', 'Conjunto excede o limite de registros.');
  return rows.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`Registro ${index} invalido.`);
    const lower = Object.fromEntries(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
    const row = {};
    for (const field of dataset === 'usuarios' ? userFields : saleFields) {
      const value = lower[field];
      if (field === 'responsavel' && value === null) { row[field] = null; continue; }
      if (numericFields.has(field)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`Registro ${index}: ${field} deve ser numero.`);
        row[field] = value;
      } else {
        if (typeof value !== 'string' || !value.trim()) invalid(`Registro ${index}: ${field} deve ser texto preenchido.`);
        row[field] = value.trim();
      }
    }
    for (const field of ['documento', 'responsavel', 'vendedor']) {
      if (row[field] !== undefined && row[field] !== null) row[field] = documentMask(row[field], 11, field);
    }
    for (const field of ['filial', 'filial_cnpj']) {
      if (row[field] !== undefined) row[field] = documentMask(row[field], 14, field);
    }
    if (dataset === 'vendas' && !validDate(row.pedido_data_venda)) invalid(`Registro ${index}: data da venda invalida.`);
    return row;
  });
}

export function saleFilters(url, body, maxProducts) {
  if (!body || !Array.isArray(body.produtos) || body.produtos.length > maxProducts ||
      body.produtos.some(p => typeof p !== 'string' || !p.trim())) {
    throw new AppError(400, 'FILTER_INVALID', 'Informe produtos como lista de codigos em texto, dentro do limite.');
  }
  const start = url.searchParams.get('date_start');
  const end = url.searchParams.get('date_end');
  if ((start !== null && !validDate(start)) || (end !== null && !validDate(end)) || (start && end && start > end)) {
    throw new AppError(400, 'DATE_INVALID', 'Periodo invalido. Use YYYY-MM-DD HH:MM:SS.');
  }
  return { products: new Set(body.produtos.map(p => p.trim())), start, end };
}

export function filterSales(rows, { products, start, end }) {
  return rows.filter(row => products.has(row.produto_id) && (!start || row.pedido_data_venda >= start) && (!end || row.pedido_data_venda <= end));
}
