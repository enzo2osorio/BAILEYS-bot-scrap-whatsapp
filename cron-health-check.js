#!/usr/bin/env node
/**
 * 🕐 CRON JOB PARA HEALTH CHECK Y AUTO-RECOVERY
 * 
 * Este script se puede ejecutar desde un cron job externo (como cron-job.org)
 * para verificar la salud del bot y forzar recovery si es necesario.
 * 
 * Uso:
 * 1. Configurar en cron-job.org o similar
 * 2. Ejecutar cada 10-15 minutos
 * 3. URL: https://tu-app.onrender.com/health
 * 4. Recovery: https://tu-app.onrender.com/force-recovery/TU_ACCESS_KEY
 */

const https = require('https');
const { URL } = require('url');

const BOT_URL = process.env.BOT_URL || 'https://tu-app.onrender.com';
const ACCESS_KEY = process.env.ACCESS_KEY || 'default-clear-key-12345';
const TIMEOUT_MS = 30000; // 30 segundos timeout

async function makeRequest(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeout,
      headers: {
        'User-Agent': 'Bot-Health-Check/1.0'
      }
    };

    const req = (parsedUrl.protocol === 'https:' ? https : require('http')).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function checkBotHealth() {
  console.log(`🩺 Verificando salud del bot: ${BOT_URL}/health`);
  
  try {
    const response = await makeRequest(`${BOT_URL}/health`);
    
    if (response.status === 200 && response.data.status === 'ok') {
      const isWhatsAppConnected = response.data.whatsapp?.connected;
      const isMongoConnected = response.data.mongo?.connected;
      
      console.log('✅ Bot respondiendo correctamente');
      console.log(`📱 WhatsApp: ${isWhatsAppConnected ? '✅' : '❌'}`);
      console.log(`🍃 Mongo: ${isMongoConnected ? '✅' : '❌'}`);
      
      if (!isWhatsAppConnected) {
        console.log('⚠️ WhatsApp desconectado - iniciando recovery...');
        return await forceRecovery();
      }
      
      return { success: true, message: 'Bot saludable' };
      
    } else {
      console.log(`❌ Health check falló: ${response.status}`);
      return await forceRecovery();
    }
    
  } catch (error) {
    console.log(`❌ Error en health check: ${error.message}`);
    return await forceRecovery();
  }
}

async function forceRecovery() {
  console.log(`🔄 Intentando recovery forzado: ${BOT_URL}/force-recovery/${ACCESS_KEY}`);
  
  try {
    const response = await makeRequest(`${BOT_URL}/force-recovery/${ACCESS_KEY}`);
    
    if (response.status === 200) {
      console.log('✅ Recovery completado exitosamente');
      return { success: true, message: 'Recovery exitoso', data: response.data };
    } else {
      console.log(`❌ Recovery falló: ${response.status} - ${JSON.stringify(response.data)}`);
      return { success: false, message: 'Recovery falló', status: response.status };
    }
    
  } catch (error) {
    console.log(`❌ Error en recovery: ${error.message}`);
    return { success: false, message: error.message };
  }
}

async function get428Stats() {
  try {
    const response = await makeRequest(`${BOT_URL}/stats-428/${ACCESS_KEY}`);
    
    if (response.status === 200) {
      const stats = response.data.error428Stats;
      console.log(`📊 Errores 428 recientes: ${stats.recentErrors}/${stats.maxErrors}`);
      
      if (stats.shouldTriggerRecovery) {
        console.log('🚨 Umbral 428 alcanzado - el bot debería auto-recuperarse');
      }
    }
  } catch (error) {
    console.log(`⚠️ No se pudieron obtener stats 428: ${error.message}`);
  }
}

// Ejecutar health check
async function main() {
  console.log(`🚀 Iniciando health check del bot - ${new Date().toISOString()}`);
  
  const result = await checkBotHealth();
  await get428Stats();
  
  console.log(`📋 Resultado: ${JSON.stringify(result)}`);
  console.log('✅ Health check completado\n');
  
  // Exit code para cron jobs
  process.exit(result.success ? 0 : 1);
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Error crítico en health check:', error);
    process.exit(1);
  });
}

module.exports = { checkBotHealth, forceRecovery, get428Stats };