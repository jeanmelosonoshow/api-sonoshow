import { AppError } from './config.js';

const userFields = ['nome', 'filial', 'filial_nome', 'filial_estado', 'filial_cidade', 'filial_regional', 'documento', 'cargo', 'responsavel'];
const saleFields = ['filial_cnpj', 'pedido_id', 'nota_numero', 'pedido_data_venda', 'vendedor', 'produto_id', 'produto_ean', 'produto_descricao', 'produto_qtd', 'produto_valor', 'produto_desconto', 'fornecedor_cnpj', 'fornecedor_razao', 'fornecedor_fantasia'];
const numericFields = new Set(['produto_qtd', 'produto_valor', 'produto_desconto']);
const invalid = (message) => { throw new AppError(422, 'DATA_INVALID', message); };

function diagnosticValue(value, maximum = 120) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  return String(value).trim().slice(0, maximum) || null;
}

function rejectedRecord(dataset, input, index, error) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key.trim().toLowerCase(), value]))
    : {};
  const base = { registro: index + 1, motivo: String(error.message).slice(0, 500) };
  return dataset === 'usuarios'
    ? { ...base, nome: diagnosticValue(source.nome), documento: diagnosticValue(source.documento, 30) }
    : { ...base, pedido_id: diagnosticValue(source.pedido_id, 60), produto_id: diagnosticValue(source.produto_id, 60),
        vendedor: diagnosticValue(source.vendedor, 30), filial_cnpj: diagnosticValue(source.filial_cnpj, 30) };
}

export function normalizeRejected(dataset, rows, maxRows) {
  if (!['usuarios', 'vendas'].includes(dataset) || !Array.isArray(rows) || rows.length > maxRows) {
    throw new AppError(422, 'REJECTIONS_INVALID', 'Lista de registros rejeitados invalida.');
  }
  const fields = dataset === 'usuarios'
    ? ['nome', 'documento']
    : ['pedido_id', 'produto_id', 'vendedor', 'filial_cnpj'];
  return rows.map(item => {
    if (!item || !Number.isSafeInteger(item.registro) || item.registro < 1 ||
        typeof item.motivo !== 'string' || !item.motivo.trim() || item.motivo.length > 500) {
      throw new AppError(422, 'REJECTIONS_INVALID', 'Registro rejeitado invalido.');
    }
    const result = { registro: item.registro, motivo: item.motivo.trim() };
    for (const field of fields) {
      if (item[field] !== null && item[field] !== undefined && typeof item[field] !== 'string') {
        throw new AppError(422, 'REJECTIONS_INVALID', `Campo ${field} invalido em rejeitados.`);
      }
      result[field] = item[field]?.trim().slice(0, 120) || null;
    }
    return result;
  });
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const date = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19).replace('T', ' ') === value;
}

function documentMask(value, size, field) {
  // CPF/CNPJ stored in numeric Firebird columns lose their leading zeroes.
  if (typeof value !== 'string' || !/^[\d./-]+$/.test(value)) invalid(`Campo ${field} deve ser texto com CPF/CNPJ.`);
  let digits = value.replace(/\D/g, '');
  if (/^\d+$/.test(value) && digits.length < size) digits = digits.padStart(size, '0');
  if (digits.length !== size) invalid(`Campo ${field} com tamanho invalido.`);
  return size === 11 ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

export function normalizeRows(dataset, rows, maxRows, rejectedRows = []) {
  if (!['usuarios', 'vendas'].includes(dataset) || !Array.isArray(rows)) invalid('Conjunto de dados invalido.');
  if (rows.length > maxRows) throw new AppError(413, 'TOO_MANY_ROWS', 'Conjunto excede o limite de registros.');
  const normalized = rows.map((input, index) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`Registro ${index} invalido.`);
      const lower = Object.fromEntries(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
      const row = {};
      for (const field of dataset === 'usuarios' ? userFields : saleFields) {
        const value = dataset === 'vendas' && field === 'nota_numero' &&
          (lower[field] === null || lower[field] === undefined || String(lower[field]).trim() === '')
          ? '0'
          : lower[field];
        if (field === 'responsavel' && value === null) { row[field] = null; continue; }
        if (field === 'fornecedor_cnpj' &&
            (value === null || value === undefined || String(value).trim() === '')) {
          row[field] = null;
          continue;
        }
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
      for (const field of ['filial', 'filial_cnpj', 'fornecedor_cnpj']) {
        if (row[field] !== undefined && row[field] !== null) row[field] = documentMask(row[field], 14, field);
      }
      if (dataset === 'vendas' && !validDate(row.pedido_data_venda)) invalid(`Registro ${index}: data da venda invalida.`);
      return row;
    } catch (error) {
      if (dataset === 'usuarios' && error instanceof AppError && error.code === 'DATA_INVALID') {
        rejectedRows.push(rejectedRecord(dataset, input, index, error));
        return null;
      }
      if (dataset === 'vendas' && error instanceof AppError && error.code === 'DATA_INVALID' &&
          error.message.includes('vendedor')) {
        rejectedRows.push(rejectedRecord(dataset, input, index, error));
        return null;
      }
      throw error;
    }
  });
  return normalized.filter(row => row !== null);
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
