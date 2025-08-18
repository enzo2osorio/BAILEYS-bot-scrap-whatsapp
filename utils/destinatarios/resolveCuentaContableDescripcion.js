const supabase = require("../../supabase");
const { getMetodoPagoIdByNameStrict } = require("./getMetodoPagoIdByName");
const { getOwnerIdByNameStrict } = require("./getOwnerIdByName");

async function cuentaLinkExists(ownerName, metodoPagoName) {
  try {
    const ownerId = await getOwnerIdByNameStrict(ownerName);
    const metodoId = await getMetodoPagoIdByNameStrict(metodoPagoName);
    if (!ownerId || !metodoId) {
      const fallback = (metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null;
      return { exists: false, id: null, description: fallback };
    }

    const { data, error } = await supabase
      .from('metodo_pago_destinatario_duenos')
      .select('id, description')
      .eq('destinatario_id', ownerId)
      .eq('metodo_pago_id', metodoId)
      .maybeSingle();

    if (error) {
      console.log('⚠️ Error buscando descripción de cuenta:', error.message);
      const fallback = (metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null;
      return { exists: false, id: null, description: fallback };
    }

    if (data?.id) {
      return { exists: true, id: data.id, description: data.description || `${metodoPagoName} de ${ownerName}` };
    }

    return { exists: false, id: null, description: `${metodoPagoName} de ${ownerName}` };
  } catch (e) {
    console.log('⚠️ Excepción resolviendo cuenta contable:', e?.message || String(e));
    const fallback = (metodoPagoName && ownerName) ? `${metodoPagoName} de ${ownerName}` : null;
    return { exists: false, id: null, description: fallback };
  }
}

async function findCuentaLinkByIds(ownerId, metodoId) {
  try {
    const { data, error } = await supabase
      .from('metodo_pago_destinatario_duenos')
      .select('id, description')
      .eq('destinatario_id', ownerId)
      .eq('metodo_pago_id', metodoId)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

async function createCuentaContableLink(ownerId, metodoId, description) {
  try {
    // Evitar duplicados: check previo
    const existing = await findCuentaLinkByIds(ownerId, metodoId);
    if (existing?.id) {
      return { ...existing, existed: true };
    }

    const payload = {
      destinatario_id: ownerId,
      metodo_pago_id: metodoId,
      description,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('metodo_pago_destinatario_duenos')
      .insert([payload])
      .select()
      .single();

    if (error) {
      // Por si hay restricción unique a nivel BD
      if ((error.code === '23505') || /duplicate/i.test(error.message || '')) {
        const again = await findCuentaLinkByIds(ownerId, metodoId);
        if (again?.id) return { ...again, existed: true };
      }
      console.log('❌ Error creando cuenta contable:', error.message);
      return null;
    }
    return { ...data, existed: false };
  } catch (e) {
    console.log('❌ Excepción creando cuenta contable:', e?.message || String(e));
    return null;
  }
}

module.exports = { cuentaLinkExists, createCuentaContableLink };