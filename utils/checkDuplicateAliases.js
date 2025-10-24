// Agregar después de saveDestinatarioAliases (línea ~340)

const supabase = require("../supabase");

// 🔍 Verificar aliases duplicados antes de guardar
const checkDuplicateAliases = async (aliases) => {
  try {
    // Obtener todos los aliases existentes de la base de datos
    const { data: existingAliases, error } = await supabase
      .from('destinatario_aliases')
      .select('alias')
      .order('alias');
    
    if (error) {
      console.error("❌ Error obteniendo aliases existentes:", error);
      // En caso de error, proceder con todos los aliases (mejor que fallar)
      return {
        validAliases: aliases,
        duplicates: [],
        errors: [`Error verificando duplicados: ${error.message}`]
      };
    }
    
    // Crear set de aliases existentes para búsqueda O(1)
    const existingAliasesSet = new Set(
      (existingAliases || []).map(item => item.alias.toLowerCase().trim())
    );
    // Separar aliases válidos de duplicados
    const validAliases = [];
    const duplicates = [];
    
    for (const alias of aliases) {
      const normalizedAlias = alias.toLowerCase().trim();
      
      if (existingAliasesSet.has(normalizedAlias)) {
        duplicates.push(alias);
        console.log(`❌ Alias duplicado encontrado: "${alias}"`);
      } else {
        validAliases.push(alias);
      }
    }
    console.log(`✅ Verificación completada: ${validAliases.length} válidos, ${duplicates.length} duplicados`);
    
    return {
      validAliases,
      duplicates,
      errors: []
    };
    
  } catch (error) {
    console.error('❌ Error en checkDuplicateAliases:', error.message);
    
    // En caso de error, proceder con todos los aliases
    return {
      validAliases: aliases,
      duplicates: [],
      errors: [`Error inesperado: ${error.message}`]
    };
  }
};

module.exports = checkDuplicateAliases;