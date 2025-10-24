const fuzzball = require('fuzzball');
const supabase = require('../supabase');

// 🔍 Verificar si existe un destinatario similar con fuzzy matching
const checkSimilarDestinatario = async (nombreNuevo) => {
  try {
    // Obtener todos los destinatarios de la base de datos
    const { data: allDestinatarios, error } = await supabase
      .from('destinatarios')
      .select('id, name')
      .order('name');
    
    if (error) {
      console.error("Error obteniendo destinatarios para fuzzy matching:", error);
      return null;
    }
    
    if (!allDestinatarios || allDestinatarios.length === 0) {
      console.log("📋 No hay destinatarios en la base de datos");
      return null;
    }
    
    // Buscar coincidencias con fuzzball
    let bestMatch = null;
    let bestScore = 0;
    
    for (const destinatario of allDestinatarios) {
      const score = fuzzball.ratio(nombreNuevo.toLowerCase(), destinatario.name.toLowerCase());
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = destinatario;
      }
    }
    
    // 🎯 NUEVA LÓGICA: Coincidencia exacta (score 100)
    if (bestScore === 100) {
      return {
        destinatario: bestMatch,
        score: bestScore,
        isExactMatch: true // 🆕 Flag para identificar coincidencia exacta
      };
    }
    
    // Coincidencia similar (score 94-99)
    if (bestScore >= 94) {
      return {
        destinatario: bestMatch,
        score: bestScore,
        isExactMatch: false // 🆕 Flag para identificar coincidencia similar
      };
    }
    
    console.log(`❌ No se encontraron destinatarios similares (mejor score: ${bestScore})`);
    return null;
    
  } catch (error) {
    console.error('❌ Error en checkSimilarDestinatario:', error.message);
    return null;
  }
};

module.exports = checkSimilarDestinatario;