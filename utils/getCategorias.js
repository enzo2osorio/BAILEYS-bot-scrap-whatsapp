const getCategorias = async () => {
  try {
    console.log("🔍 Intentando obtener categorías de Supabase...");
    
    const { data, error } = await supabase
      .from('categorias')
      .select('id, name')
      .order('name');
    
    if (error) {
      console.error("❌ Error en Supabase getCategorias:", error);
      throw error;
    }
    
    console.log(`✅ Categorías obtenidas: ${data?.length || 0}`);
    if (data?.length > 0) {
      console.log("📋 Categorías:", data.map(c => `${c.id}: ${c.nombre}`).join(', '));
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error obteniendo categorías:', error.message);
    return [];
  }
};

export default getCategorias;