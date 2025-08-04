const saveNewDestinatario = async (nombre, categoriaId, subcategoriaId) => {
  try {
    const { data, error } = await supabase
      .from('destinatarios')
      .insert([
        { 
          name: nombre,
          category_id: categoriaId,
          subcategory_id: subcategoriaId,
          created_at: new Date().toISOString()
        }
      ])
      .select();
    
    if (error) throw error;
    return data?.[0] || null;
  } catch (error) {
    console.error('Error guardando nuevo destinatario:', error);
    return null;
  }
};

module.exports = saveNewDestinatario;