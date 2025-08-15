const getMetodosPago = require('../getMetodosPago.js');

// Normaliza cadenas: trim, lower, sin tildes y sin separadores comunes
function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-_.]/g, '');
}

function cleanAmount(raw) {
  if (raw == null || raw === '') return 'No especificado';
  if (typeof raw === 'number') return raw;
  const num = parseFloat(String(raw).replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return isNaN(num) ? raw : num;
}

function isValidDateDDMMYYYY(s) {
  if (typeof s !== 'string') return false;
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!m) return false;
  const d = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, y = parseInt(m[3], 10);
  const dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d;
}

function normalizeTipoMovimiento(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  return v === 'ingreso' ? 'ingreso' : v === 'egreso' ? 'egreso' : null;
}

function isPositiveNumber(n) {
  return typeof n === 'number' && isFinite(n) && n > 0;
}

// Tolerante a tildes y separadores
async function isKnownMedioPago(name) {
  if (!name) return false;
  try {
    const metodos = await getMetodosPago();
    if (!Array.isArray(metodos) || metodos.length === 0) return false;
    const target = norm(name);
    return metodos.some(m => norm(m.name) === target);
  } catch {
    return false;
  }
}

// Devuelve lista de issues: [{ code, field, message }]
async function validateFinalData(fd) {
  const issues = [];

  // Destinatario
  if (!fd?.nombre || !String(fd.nombre).trim()) {
    issues.push({ code: 'MISSING_DESTINATARIO', field: 'nombre', message: 'Falta el destinatario.' });
  }

  // Monto
  const montoVal = cleanAmount(fd?.monto);
  if (montoVal === 'No especificado' || isNaN(Number(montoVal)) || !isPositiveNumber(Number(montoVal))) {
    issues.push({ code: 'INVALID_MONTO', field: 'monto', message: 'El monto es inválido o está vacío.' });
  }

  // Fecha
  if (!fd?.fecha || !isValidDateDDMMYYYY(fd.fecha)) {
    issues.push({ code: 'INVALID_FECHA', field: 'fecha', message: 'La fecha falta o no tiene formato dd/mm/yyyy.' });
  }

  // Tipo de movimiento
  const tipo = normalizeTipoMovimiento(fd?.tipo_movimiento);
  if (!tipo) {
    issues.push({ code: 'INVALID_TIPO_MOV', field: 'tipo_movimiento', message: 'El tipo de movimiento falta o es inválido.' });
  }

  // Medio de pago
  if (!fd?.medio_pago || !(await isKnownMedioPago(fd.medio_pago))) {
    issues.push({ code: 'INVALID_MEDIO_PAGO', field: 'medio_pago', message: 'El método de pago falta o no es válido.' });
  }

  // Cuenta contable (opcional)
  if (!fd?.cuenta_contable) {
    issues.push({ code: 'MISSING_CUENTA_CONTABLE', field: 'cuenta_contable', message: 'Cuenta contable no establecida (opcional).' });
  }

  return issues;
}

module.exports = {
  validateFinalData,
  isKnownMedioPago,
  cleanAmount,
  normalizeTipoMovimiento,
  isValidDateDDMMYYYY
};