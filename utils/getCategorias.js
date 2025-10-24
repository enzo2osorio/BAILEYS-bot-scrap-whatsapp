const supabase = require("../supabase");

const getCategorias = async () => {
  try {
    const { data, error } = await supabase
      .from('categorias')
      .select('id, name')
      .order('name');
    
    if (error) {
      console.error("❌ Error en Supabase getCategorias:", error);
      throw error;
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error obteniendo categorías:', error.message);
    return [];
  }
};

module.exports = getCategorias;