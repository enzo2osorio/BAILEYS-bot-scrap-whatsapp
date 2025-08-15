const supabase = require("../../supabase");

async function getOwnerIdByNameStrict(ownerName) {
  if (!ownerName) return null;
  const { data, error } = await supabase
    .from('destinatarios')
    .select('id,name')
    .eq('name', ownerName)
    .maybeSingle();
  if (error) {
    console.log('⚠️ Error buscando destinatario dueño:', error.message);
    return null;
  }
  return data?.id || null;
}

module.exports = {
  getOwnerIdByNameStrict
};