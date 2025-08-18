const supabase = require("../../supabase");
const { getMetodoPagoIdByNameStrict } = require("./getMetodoPagoIdByName");
const { getOwnerIdByNameStrict } = require("./getOwnerIdByName");

async function cuentaLinkExists(ownerName, metodoPagoName) {
  try {
    const ownerId = await getOwnerIdByNameStrict(ownerName);
    const metodoId = await getMetodoPagoIdByNameStrict(metodoPagoName);
    if (!ownerId || !metodoId) {
      return (metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null;
    }
    const { data, error } = await supabase
      .from('metodo_pago_destinatario_duenos')
      .select('id,description')
      .eq('destinatario_id', ownerId)
      .eq('metodo_pago_id', metodoId)
      .maybeSingle();

    if (error) {
      console.log('⚠️ Error buscando descripción de cuenta:', error.message);
      return (metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null;
    }

    return data?.description || ((metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null);
  } catch (e) {
    console.log('⚠️ Excepción resolviendo cuenta contable:', e?.message || String(e));
    return (metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null;
  }
}


async function createCuentaContableLink(ownerId, metodoId, description) {
  try {
    const payload = {
      destinatario_id: ownerId,
      metodo_pago_id: metodoId,
      description: description,
      created_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('metodo_pago_destinatario_duenos')
      .insert([payload])
      .select()
      .single();
    if (error) {
      console.log('❌ Error creando cuenta contable:', error.message);
      return null;
    }
    return data; // { id, ... }
  } catch (e) {
    console.log('❌ Excepción creando cuenta contable:', e?.message || String(e));
    return null;
  }
}

module.exports = {cuentaLinkExists, createCuentaContableLink}