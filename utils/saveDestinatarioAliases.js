// Agregar después de checkSimilarDestinatario

const supabase = require("../supabase");

// 💾 Guardar aliases de destinatario en Supabase
// Reemplazar la función saveDestinatarioAliases en utils/saveDestinatarioAliases.js
// 💾 Guardar aliases de destinatario en Supabase (versión mejorada)
const saveDestinatarioAliases = async (destinatarioId, aliases) => {
  try {
    if (!aliases || aliases.length === 0) {
      console.log("ℹ️ No hay aliases para guardar");
      return true;
    }
    
    console.log(`💾 Guardando ${aliases.length} aliases para destinatario ID: ${destinatarioId}`);
    
    // Preparar datos para inserción
    const aliasesData = aliases.map(alias => ({
      destinatario_id: destinatarioId,
      alias: alias.trim()
    }));
    
    // Insertar todos los aliases válidos
    const { data, error } = await supabase
      .from('destinatario_aliases')
      .insert(aliasesData)
      .select();
    
    if (error) {
      console.error("❌ Error guardando aliases:", error);
      
      // Si hay error de duplicado, intentar guardar uno por uno
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        console.log("🔄 Intentando guardar aliases uno por uno...");
        return await saveAliasesOneByOne(destinatarioId, aliases);
      }
      
      return false;
    }
    
    console.log(`✅ ${data.length} aliases guardados exitosamente`);
    return true;
    
  } catch (error) {
    console.error('❌ Error en saveDestinatarioAliases:', error.message);
    return false;
  }
};

// 🔄 Guardar aliases uno por uno (fallback para duplicados)
const saveAliasesOneByOne = async (destinatarioId, aliases) => {
  let savedCount = 0;
  let errorCount = 0;
  
  for (const alias of aliases) {
    try {
      const { error } = await supabase
        .from('destinatario_aliases')
        .insert([{
          destinatario_id: destinatarioId,
          alias: alias.trim()
        }]);
      
      if (error) {
        if (error.message.includes('duplicate') || error.message.includes('unique')) {
          console.log(`⚠️ Alias "${alias}" ya existe - omitido`);
        } else {
          console.error(`❌ Error guardando alias "${alias}":`, error.message);
          errorCount++;
        }
      } else {
        console.log(`✅ Alias "${alias}" guardado`);
        savedCount++;
      }
      
    } catch (error) {
      console.error(`❌ Error procesando alias "${alias}":`, error.message);
      errorCount++;
    }
  }
  
  console.log(`📊 Resumen: ${savedCount} guardados, ${errorCount} errores`);
  return savedCount > 0; // Éxito si se guardó al menos uno
};

module.exports = saveDestinatarioAliases;