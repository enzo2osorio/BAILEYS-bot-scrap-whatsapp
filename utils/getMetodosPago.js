const supabase = require("../supabase");

const getMetodosPago = async () => {
  try {
    console.log("🔍 Intentando obtener métodos de pago de Supabase...");
    
    const { data, error } = await supabase
      .from('metodos_pago')
      .select('id, name')
      .order('name');
    
    if (error) {
      console.error("❌ Error en Supabase getMetodosPago:", error);
      throw error;
    }
    
    console.log(`✅ Métodos de pago obtenidos: ${data?.length || 0}`);
    if (data?.length > 0) {
      console.log("📋 Métodos de pago:", data.map(m => `${m.id}: ${m.name}`).join(', '));
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error obteniendo métodos de pago:', error.message);
    return [];
  }
};

module.exports = getMetodosPago;