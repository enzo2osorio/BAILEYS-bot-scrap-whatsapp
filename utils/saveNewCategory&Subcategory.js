const supabase = require("../supabase");

async function saveNewCategory(name) {
  try {
    const { data, error } = await supabase
      .from('categorias')
      .insert([{ name }])
      .select()
      .single();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

async function saveNewSubcategory(name, categoryId) {
  try {
    const { data, error } = await supabase
      .from('subcategorias')
      .insert([{ name, categoria_id: categoryId }])
      .select()
      .single();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = {
  saveNewCategory,
  saveNewSubcategory
}   ;