const supabase = require("./supabase");
const getCuentaContable = require("./utils/destinatarios/getCuentaContableId");
const { getOwnerIdByNameStrict } = require("./utils/destinatarios/getOwnerIdByName");

function toTimestampFromPayload({ fecha, hora, fecha_iso }) {
  if (typeof fecha_iso === 'string' && !Number.isNaN(Date.parse(fecha_iso))) {
    return new Date(fecha_iso);
  }
  let d, m, y;
  if (typeof fecha === 'string') {
    const mres = fecha.match(/^\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s*$/);
    if (mres) { d = parseInt(mres[1],10); m = parseInt(mres[2],10); y = parseInt(mres[3],10); }
  }
  const now = new Date();
  if (d == null || m == null || y == null) {
    d = now.getDate(); m = now.getMonth() + 1; y = now.getFullYear();
  }
  let hh = 0, mm = 0;
  if (typeof hora === 'string') {
    const hres = hora.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
    if (hres) { hh = Math.min(23, parseInt(hres[1],10)); mm = Math.min(59, parseInt(hres[2],10)); }
  }
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

async function saveDataFirstFlow(params) {
  const {
    nombre: nombre_destino,
    monto,
    fecha,
    hora,
    fecha_iso,
    tipo_movimiento,
    medio_pago,
    observacion, 
    cuenta_contable
  } = params;

  // Destinatario
  const { data: existingDestinatario, error: errDest } = await supabase
    .from("destinatarios")
    .select("*")
    .eq("name", nombre_destino);

  if (errDest) return { error: "Error consultando destinatario." };
  if (!existingDestinatario || existingDestinatario.length === 0) {
    return { error: "No existe el destinatario." };
  }
  const destinatario = existingDestinatario[0];

  // Método de pago
  const { data: existingMedioPago, error: errMedio } = await supabase
    .from("metodos_pago")
    .select("*")
    .eq("name", medio_pago)
    .single();

  if (errMedio || !existingMedioPago) {
    return { error: "No existe el medio de pago." };
  }

  //hallando el owner ID

  const {data: ownerData, error: ownerError} = await supabase
  .from("destinatarios")
  .select("id")
  .eq("name", cuenta_contable)
  .single();

  if (ownerError || !ownerData) {
    console.log("⚠️ Error obteniendo ownerId:", ownerError?.message || ownerError);
    return null;
  }

  const ownerId = ownerData.id;

  //hallando la cuenta contable
  const cuentaContableId = await getCuentaContable(ownerId, existingMedioPago);
  if (!cuentaContableId) {
    return { error: "No se pudo encontrar la cuenta contable." };
  }



  // Fecha/timestamp seguro
  const ts = toTimestampFromPayload({ fecha, hora, fecha_iso });

  // Insertar registro
  const { data: dataRegistro, error: errorRegistro } = await supabase
    .from("registros")
    .insert({
      destinatario_id: destinatario.id,
      monto: monto != null ? Number(monto) : null,
      fecha: ts.toISOString(), // timestamptz
      tipo_movimiento,
      origen: "bot",
      metodo_pago_id: existingMedioPago.id,
      descripcion: observacion ?? null,
      cuenta_contable_id: cuentaContableId,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  if (errorRegistro) {
    console.log({ errorRegistro });
    return { error: "Error al guardar el registro." };
  }

  return { success: true, data: dataRegistro };
}

module.exports = saveDataFirstFlow;