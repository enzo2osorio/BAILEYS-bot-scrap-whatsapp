const supabase = require("../supabase");
const getMetodosPago = require("./getMetodosPago");

// IDs fijos de categoría y subcategoría para “dueños”
const OWNERS_CATEGORY_ID = '0ba7b565-e067-4411-9061-caa7d4f6ac83';       // administradores
const OWNERS_SUBCATEGORY_ID = '0d4fad94-6106-49e9-832e-3c94548996a7';   // dueños del negocio

async function getOwnersDueños() {
  try {
    const { data, error } = await supabase
      .from('destinatarios')
      .select('id,name')
      .eq('category_id', OWNERS_CATEGORY_ID)
      .eq('subcategory_id', OWNERS_SUBCATEGORY_ID)
      .order('name', { ascending: true });
    if (error) {
      console.error('Error obteniendo dueños:', error);
      return [];
    }
    return data || [];
  } catch (e) {
    console.log('Error getOwnersDueños:', e?.message || String(e));
    return [];
  }
}

async function getMetodoPagoNameByID(id) {
  try {
    const { data, error } = await supabase
      .from('metodos_pago')
      .select('id,name')
      .eq('id', id)
      .single();
    if (error || !data) return null;
    return data.name;
  } catch {
    return null;
  }
}

async function listCuentaLinksWithNames() {
  try {
    // 1) Traer vínculos
    const { data: links, error: errLinks } = await supabase
      .from('metodo_pago_destinatario_duenos')
      .select('id, metodo_pago_id, destinatario_id, descripcion')
      .order('descripcion', { ascending: true });
    if (errLinks) {
      console.error('Error obteniendo vínculos de cuentas:', errLinks);
      return [];
    }
    const allLinks = links || [];

    if (allLinks.length === 0) return [];

    // 2) Traer todos los métodos de pago
    const metodosPago = await getMetodosPago(); // [{id, name}]
    const mpMap = new Map((metodosPago || []).map(m => [m.id, m.name]));

    // 3) Traer dueños (solo owners válidos)
    const owners = await getOwnersDueños(); // [{id,name}]
    const ownerMap = new Map((owners || []).map(o => [o.id, o.name]));

    // 4) Armar etiquetas
    const result = [];
    for (const l of allLinks) {
      const metodoName = mpMap.get(l.metodo_pago_id) || await getMetodoPagoNameByID(l.metodo_pago_id) || 'Método desconocido';
      const ownerName = ownerMap.get(l.destinatario_id) || '(dueño no listado)';
      const label = l.descripcion || `${metodoName} de ${ownerName}`;
      result.push({
        id: l.id,
        metodo_pago_id: l.metodo_pago_id,
        owner_id: l.destinatario_id,
        metodo_name: metodoName,
        owner_name: ownerName,
        descripcion: l.descripcion || null,
        label
      });
    }
    return result;
  } catch (e) {
    console.log('Error listCuentaLinksWithNames:', e?.message || String(e));
    return [];
  }
}

module.exports = {
  getOwnersDuenos: getOwnersDueños,
  getOwnersDueños,
  getMetodoPagoNameByID,
  listCuentaLinksWithNames
};