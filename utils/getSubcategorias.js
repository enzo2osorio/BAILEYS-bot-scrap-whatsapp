const supabase = require("../supabase");

const getSubcategorias = async (categoriaId) => {
  try {
    console.log(`🔍 Intentando obtener subcategorías para categoría ID: ${categoriaId}`);
    
    const { data, error } = await supabase
      .from('subcategorias')
      .select('id, name')
      .eq('categoria_id', categoriaId)
      .order('name');
    
    if (error) {
      console.error("❌ Error en Supabase getSubcategorias:", error);
      throw error;
    }
    
    console.log(`✅ Subcategorías obtenidas: ${data?.length || 0}`);
    if (data?.length > 0) {
      console.log("📋 Subcategorías:", data.map(s => `${s.id}: ${s.nombre}`).join(', '));
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error obteniendo subcategorías:', error.message);
    return [];
  }
};

module.exports = getSubcategorias