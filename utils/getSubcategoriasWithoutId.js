const supabase = require("../supabase");

const getSubcategoriasWithoutId = async () => {
  try {
    console.log(`🔍 Intentando obtener subcategorías sin ID`);
    
    const { data, error } = await supabase
      .from('subcategorias')
      .select('id, name')
    
    if (error) {
      console.error("❌ Error en Supabase getSubcategorias:", error);
      throw error;
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error obteniendo subcategorías:', error.message);
    return [];
  }
};

module.exports = {getSubcategoriasWithoutId};