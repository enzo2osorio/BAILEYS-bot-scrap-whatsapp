const HybridWhatsAppScraper = require('./hybrid-scraper');
const path = require('path');

/**
 * 🚀 EJEMPLO DE USO DEL SCRAPER HÍBRIDO
 * 
 * Este script demuestra cómo combinar:
 * 1. Datos extraídos con Puppeteer (historial completo)
 * 2. Descarga de imágenes con Baileys (alta calidad)
 */

async function runHybridExtraction() {
  console.log('🎯 INICIANDO EXTRACCIÓN HÍBRIDA PUPPETEER + BAILEYS');
  console.log('=' * 70);

  // Configuración del scraper híbrido
  const hybridScraper = new HybridWhatsAppScraper({
    downloadImages: true,
    downloadVideos: true,
    outputDir: './hybrid-output',
    baileysSession: 'session_auth_info', // Usar la misma sesión del proyecto actual
    logLevel: 'silent'
  });

  try {
    // PASO 1: Configurar rutas de datos
    const puppeteerDataPath = './puppeteer-data/contact-messages.json'; // Archivo generado por tu Puppeteer
    const contactJID = '521XXXXXXXXXX@s.whatsapp.net'; // JID del contacto en formato Baileys
    const contactName = 'NombreContacto'; // Nombre para organizar archivos

    console.log(`📂 Archivo de Puppeteer: ${puppeteerDataPath}`);
    console.log(`👤 Contacto JID: ${contactJID}`);
    console.log(`📝 Nombre: ${contactName}`);

    // PASO 2: Ejecutar proceso híbrido
    const result = await hybridScraper.processHybridExtraction(
      puppeteerDataPath,
      contactJID,
      contactName
    );

    // PASO 3: Mostrar resultados
    if (result.success) {
      console.log('\n🎉 ¡EXTRACCIÓN HÍBRIDA EXITOSA!');
      console.log(`📊 Estadísticas finales:`);
      console.log(`   💬 Mensajes procesados: ${result.report.totalMessages}`);
      console.log(`   🖼️ Imágenes descargadas: ${result.stats.images}`);
      console.log(`   📹 Videos descargados: ${result.stats.videos}`);
      console.log(`   ❌ Errores: ${result.stats.errors}`);
      console.log(`   📁 Archivos en: ${result.report.outputDir}`);
    } else {
      console.error('❌ Error en extracción híbrida:', result.error);
    }

  } catch (error) {
    console.error('❌ Error inesperado:', error);
  } finally {
    // Limpiar conexiones
    await hybridScraper.cleanup();
  }
}

/**
 * 🔧 FUNCIÓN PARA CONVERTIR DATOS DE PUPPETEER AL FORMATO ESPERADO
 */
function convertPuppeteerData(originalPuppeteerFile, outputFile) {
  console.log('🔄 Convirtiendo datos de Puppeteer al formato híbrido...');
  
  // Esta función adapta tus datos de Puppeteer al formato que espera el scraper híbrido
  // Modifícala según la estructura exacta de tus datos de Puppeteer
  
  const fs = require('fs');
  const originalData = JSON.parse(fs.readFileSync(originalPuppeteerFile, 'utf8'));
  
  const convertedData = originalData.map((msg, index) => ({
    id: index + 1,
    content: msg.content || '',
    type: msg.type || 'text',
    isOwn: msg.isOwn || false,
    fullDateTime: msg.fullDateTime || null,
    timestamp: msg.timestamp || null,
    quotedMessage: msg.quotedMessage || null,
    imageUrls: msg.imageUrls || [],
    metadata: msg.metadata || {}
  }));
  
  fs.writeFileSync(outputFile, JSON.stringify(convertedData, null, 2));
  console.log(`✅ Datos convertidos guardados en: ${outputFile}`);
  
  return convertedData;
}

/**
 * 🚀 SCRIPT PRINCIPAL
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('📋 USO DEL SCRIPT:');
    console.log('');
    console.log('1. Ejecutar extracción híbrida:');
    console.log('   node hybrid-example.js extract');
    console.log('');
    console.log('2. Convertir datos de Puppeteer:');
    console.log('   node hybrid-example.js convert <archivo-puppeteer> <archivo-salida>');
    console.log('');
    console.log('📝 PASOS PREVIOS NECESARIOS:');
    console.log('1. Ejecuta tu scraper de Puppeteer y guarda los datos en JSON');
    console.log('2. Asegúrate de que Baileys esté conectado (escanea QR si es necesario)');
    console.log('3. Modifica las rutas y JID en este script según tus datos');
    console.log('');
    return;
  }
  
  const command = args[0];
  
  switch (command) {
    case 'extract':
      await runHybridExtraction();
      break;
      
    case 'convert':
      if (args.length < 3) {
        console.error('❌ Uso: node hybrid-example.js convert <archivo-puppeteer> <archivo-salida>');
        return;
      }
      convertPuppeteerData(args[1], args[2]);
      break;
      
    default:
      console.error('❌ Comando no reconocido:', command);
      console.log('💡 Comandos disponibles: extract, convert');
  }
}

// Ejecutar script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  runHybridExtraction,
  convertPuppeteerData
};
