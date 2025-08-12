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

module.exports = {getSubcategoriasWithoutId};