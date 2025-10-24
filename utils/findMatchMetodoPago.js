const getMetodosPago = require("./getMetodosPago");
const fuzz = require('fuzzball');

const matchMetodoPago = async (inputMetodoPago) => {
  try {
    if (!inputMetodoPago || inputMetodoPago.trim() === '') {
      console.log("⚠️ Input de método de pago vacío");
      return { name: null, score: 0 };
    }

    // Obtener todos los métodos de pago de la base de datos
    const metodosPago = await getMetodosPago();
    
    if (metodosPago.length === 0) {
      console.log("⚠️ No hay métodos de pago en la base de datos");
      return { name: null, score: 0 };
    }

    let bestMatch = { name: null, score: 0 };
    const UMBRAL_MINIMO = 70; // Umbral mínimo para considerar una coincidencia válida

    // Comparar con cada método de pago usando fuzzball
    for (const metodoPago of metodosPago) {
      const score = fuzz.ratio(inputMetodoPago.toLowerCase(), metodoPago.name.toLowerCase());
      if (score > bestMatch.score) {
        bestMatch = {
          name: metodoPago.name,
          id: metodoPago.id,
          score: score
        };
      }
    }

    // Solo devolver el match si supera el umbral
    if (bestMatch.score >= UMBRAL_MINIMO) {     
      return bestMatch;
    } else {
      console.log(`❌ No se encontró coincidencia válida. Mejor score: ${bestMatch.score}% (mínimo: ${UMBRAL_MINIMO}%)`);
      return { name: null, score: bestMatch.score };
    }

  } catch (error) {
    console.error('❌ Error en matchMetodoPago:', error.message);
    return { name: null, score: 0 };
  }
};

module.exports = matchMetodoPago;