const supabase = require("../../supabase");

async function getMetodoPagoIdByNameStrict(metodoPagoName) {
  if (!metodoPagoName) return null;
  const { data, error } = await supabase
    .from('metodos_pago')
    .select('id,name')
    .eq('name', metodoPagoName)
    .maybeSingle();

  if (error) {
    console.log('⚠️ Error buscando método de pago:', error.message);
    return null;
  }
  return data?.id || null;
}

module.exports = {
  getMetodoPagoIdByNameStrict
};