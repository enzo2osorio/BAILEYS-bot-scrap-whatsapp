const {
  default: makeWASocket,
  downloadMediaMessage,
  getContentType,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");
const log = require("pino");
const fs = require('fs').promises;
const path = require('path');

/**
 * 🔄 SCRAPER HÍBRIDO: Puppeteer + Baileys
 * 
 * Combina lo mejor de ambos mundos:
 * - Puppeteer: Extrae historial completo navegando en WhatsApp Web
 * - Baileys: Descarga imágenes y media en alta calidad
 */
class HybridWhatsAppScraper {
  constructor(config = {}) {
    this.config = {
      downloadImages: true,
      downloadVideos: true,
      outputDir: './hybrid-output',
      baileysSession: 'session_auth_info',
      logLevel: 'silent',
      ...config
    };
    
    this.puppeteerData = null;
    this.baileysSocket = null;
    this.messageStore = {};
    this.downloadStats = {
      images: 0,
      videos: 0,
      errors: 0
    };
  }

  /**
   * 🚀 PASO 1: Inicializar conexión Baileys para descarga de media
   */
  async initializeBaileys() {
    try {
      console.log('🔧 Inicializando Baileys para descarga de media...');
      
      const { state, saveCreds } = await useMultiFileAuthState(this.config.baileysSession);
      
      this.baileysSocket = makeWASocket({
        auth: state,
        logger: log({ level: this.config.logLevel }),
        browser: Browsers.windows('Desktop'),
        syncFullHistory: false, // No necesitamos historial, solo descarga
        markOnlineOnConnect: false,
        printQRInTerminal: false
      });

      // Manejar eventos de conexión
      this.baileysSocket.ev.on('connection.update', ({ connection, qr }) => {
        if (connection === 'open') {
          console.log('✅ Baileys conectado exitosamente');
        } else if (qr) {
          console.log('📱 Escanea este QR para conectar Baileys:');
          console.log(qr);
        }
      });

      this.baileysSocket.ev.on('creds.update', saveCreds);

      // Esperar conexión
      await this.waitForBaileysConnection();
      
      console.log('✅ Baileys listo para descarga de media');
      return true;
    } catch (error) {
      console.error('❌ Error inicializando Baileys:', error);
      return false;
    }
  }

  /**
   * ⏳ Esperar conexión de Baileys
   */
  async waitForBaileysConnection() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout esperando conexión Baileys'));
      }, 60000);

      this.baileysSocket.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  /**
   * 📥 PASO 2: Cargar datos extraídos por Puppeteer
   */
  async loadPuppeteerData(filePath) {
    try {
      console.log(`📂 Cargando datos de Puppeteer desde: ${filePath}`);
      
      const rawData = await fs.readFile(filePath, 'utf8');
      this.puppeteerData = JSON.parse(rawData);
      
      console.log(`✅ Datos cargados: ${this.puppeteerData.length} mensajes encontrados`);
      
      // Analizar tipos de mensajes
      const stats = this.analyzePuppeteerData();
      console.log('📊 Análisis de datos:');
      console.log(`   💬 Mensajes de texto: ${stats.textMessages}`);
      console.log(`   🖼️ Mensajes con imágenes: ${stats.imageMessages}`);
      console.log(`   📹 Mensajes con videos: ${stats.videoMessages}`);
      
      return true;
    } catch (error) {
      console.error('❌ Error cargando datos de Puppeteer:', error);
      return false;
    }
  }

  /**
   * 📊 Analizar datos de Puppeteer
   */
  analyzePuppeteerData() {
    const stats = {
      textMessages: 0,
      imageMessages: 0,
      videoMessages: 0,
      total: this.puppeteerData.length
    };

    this.puppeteerData.forEach(msg => {
      if (msg.type === 'image' || msg.imageUrls?.length > 0) {
        stats.imageMessages++;
      } else if (msg.type === 'video') {
        stats.videoMessages++;
      } else {
        stats.textMessages++;
      }
    });

    return stats;
  }

  /**
   * 🔍 PASO 3: Buscar mensajes con media en el store de Baileys
   */
  async findMediaMessagesInBaileys(jid) {
    try {
      console.log(`🔍 Buscando mensajes con media para JID: ${jid}`);
      
      // Cargar historial usando fetchMessageHistory (método más directo)
      let allMessages = [];
      let cursor = null;
      let batchCount = 0;
      const maxBatches = 20; // Límite de seguridad
      
      while (batchCount < maxBatches) {
        try {
          console.log(`📦 Cargando lote ${++batchCount}...`);
          
          // Usar fetchMessageHistory que es más eficiente para media
          const rawData = await this.baileysSocket.fetchMessageHistory(50, cursor);
          const data = JSON.parse(rawData);
          const messages = data.messages || [];
          
          if (messages.length === 0) break;
          
          // Filtrar solo mensajes con media
          const mediaMessages = messages.filter(msg => {
            const content = getContentType(msg.message || {});
            return ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(content);
          });
          
          allMessages = allMessages.concat(mediaMessages);
          
          // Actualizar cursor
          cursor = messages[messages.length - 1].key;
          
          console.log(`   ✅ Lote ${batchCount}: ${mediaMessages.length} mensajes con media encontrados`);
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.log(`   ⚠️ Error en lote ${batchCount}:`, error.message);
          break;
        }
      }
      
      console.log(`🎯 Total de mensajes con media encontrados: ${allMessages.length}`);
      this.messageStore[jid] = allMessages;
      
      return allMessages;
    } catch (error) {
      console.error('❌ Error buscando mensajes con media:', error);
      return [];
    }
  }

  /**
   * 🎯 PASO 4: Correlacionar datos de Puppeteer con mensajes de Baileys
   */
  async correlateMessages(jid) {
    console.log('🔗 Correlacionando mensajes de Puppeteer con Baileys...');
    
    const baileysMessages = this.messageStore[jid] || [];
    const correlatedMessages = [];
    
    for (const puppeteerMsg of this.puppeteerData) {
      if (puppeteerMsg.type === 'image' || puppeteerMsg.imageUrls?.length > 0) {
        // Buscar mensaje correspondiente en Baileys por timestamp o contenido
        const baileysMatch = this.findMatchingBaileysMessage(puppeteerMsg, baileysMessages);
        
        if (baileysMatch) {
          correlatedMessages.push({
            puppeteerData: puppeteerMsg,
            baileysMessage: baileysMatch,
            canDownload: true
          });
        } else {
          // No se encontró match exacto, pero podemos intentar descargar por URL
          correlatedMessages.push({
            puppeteerData: puppeteerMsg,
            baileysMessage: null,
            canDownload: false
          });
        }
      } else {
        // Mensaje de texto, no necesita correlación
        correlatedMessages.push({
          puppeteerData: puppeteerMsg,
          baileysMessage: null,
          canDownload: false
        });
      }
    }
    
    const downloadableCount = correlatedMessages.filter(m => m.canDownload).length;
    console.log(`✅ Correlación completada: ${downloadableCount} mensajes pueden descargarse con Baileys`);
    
    return correlatedMessages;
  }

  /**
   * 🎯 Buscar mensaje correspondiente en Baileys
   */
  findMatchingBaileysMessage(puppeteerMsg, baileysMessages) {
    // Estrategia 1: Matching por timestamp (si está disponible)
    if (puppeteerMsg.timestamp) {
      const timestampMatch = baileysMessages.find(bMsg => {
        const timeDiff = Math.abs(bMsg.messageTimestamp - puppeteerMsg.timestamp);
        return timeDiff < 60; // Diferencia menor a 60 segundos
      });
      if (timestampMatch) return timestampMatch;
    }
    
    // Estrategia 2: Matching por contenido de texto (caption)
    if (puppeteerMsg.content && puppeteerMsg.content.length > 10) {
      const contentMatch = baileysMessages.find(bMsg => {
        const messageContent = bMsg.message?.imageMessage?.caption || 
                              bMsg.message?.videoMessage?.caption || '';
        return messageContent.includes(puppeteerMsg.content.substring(0, 20));
      });
      if (contentMatch) return contentMatch;
    }
    
    // Estrategia 3: Matching por posición (último recurso)
    // Asumimos que los mensajes están en orden cronológico
    const imageIndex = this.puppeteerData.filter(m => m.type === 'image').indexOf(puppeteerMsg);
    const baileysImageMessages = baileysMessages.filter(m => 
      getContentType(m.message || {}) === 'imageMessage'
    );
    
    if (imageIndex < baileysImageMessages.length) {
      return baileysImageMessages[imageIndex];
    }
    
    return null;
  }

  /**
   * 📥 PASO 5: Descargar media usando Baileys
   */
  async downloadMediaWithBaileys(correlatedMessages, contactName) {
    console.log('🚀 Iniciando descarga de media con Baileys...');
    
    // Crear directorio de descarga
    const downloadDir = path.join(this.config.outputDir, `${contactName}-media`);
    await fs.mkdir(downloadDir, { recursive: true });
    
    const downloadResults = [];
    let downloadedCount = 0;
    
    for (let i = 0; i < correlatedMessages.length; i++) {
      const correlatedMsg = correlatedMessages[i];
      
      if (!correlatedMsg.canDownload || !correlatedMsg.baileysMessage) {
        continue;
      }
      
      try {
        console.log(`📥 Descargando media ${++downloadedCount}/${correlatedMessages.filter(m => m.canDownload).length}...`);
        
        const baileysMsg = correlatedMsg.baileysMessage;
        const messageType = getContentType(baileysMsg.message);
        
        // Descargar media usando Baileys
        const buffer = await downloadMediaMessage(
          baileysMsg,
          'buffer',
          {},
          {
            logger: console,
            reuploadRequest: this.baileysSocket.updateMediaMessage
          }
        );
        
        if (buffer) {
          // Determinar extensión
          const mediaMsg = baileysMsg.message[messageType];
          const mimetype = mediaMsg.mimetype || 'application/octet-stream';
          let extension = this.getExtensionFromMimetype(mimetype);
          
          // Crear nombre de archivo único
          const timestamp = baileysMsg.messageTimestamp || Date.now();
          const fileName = `${contactName}_${timestamp}_${baileysMsg.key.id}${extension}`;
          const filePath = path.join(downloadDir, fileName);
          
          // Guardar archivo
          await fs.writeFile(filePath, buffer);
          
          // Guardar información
          const downloadInfo = {
            fileName: fileName,
            filePath: filePath,
            originalPuppeteerData: correlatedMsg.puppeteerData,
            baileysMessageId: baileysMsg.key.id,
            mimetype: mimetype,
            caption: mediaMsg.caption || correlatedMsg.puppeteerData.content || '',
            downloadTime: new Date().toISOString(),
            fileSize: buffer.length
          };
          
          downloadResults.push(downloadInfo);
          this.downloadStats.images++;
          
          console.log(`   ✅ Descargado: ${fileName} (${this.formatFileSize(buffer.length)})`);
          
        } else {
          console.log(`   ❌ No se pudo descargar media para mensaje ${baileysMsg.key.id}`);
          this.downloadStats.errors++;
        }
        
      } catch (error) {
        console.error(`   ❌ Error descargando media:`, error.message);
        this.downloadStats.errors++;
      }
      
      // Pausa entre descargas
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    console.log(`✅ Descarga completada: ${downloadResults.length} archivos descargados`);
    
    // Guardar índice de descargas
    const indexPath = path.join(downloadDir, 'download_index.json');
    await fs.writeFile(indexPath, JSON.stringify(downloadResults, null, 2));
    
    return downloadResults;
  }

  /**
   * 🔧 Obtener extensión de archivo desde mimetype
   */
  getExtensionFromMimetype(mimetype) {
    const extensions = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov',
      'audio/mpeg': '.mp3',
      'audio/ogg': '.ogg',
      'application/pdf': '.pdf'
    };
    
    return extensions[mimetype] || '.bin';
  }

  /**
   * 📊 Formatear tamaño de archivo
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 🚀 MÉTODO PRINCIPAL: Proceso completo híbrido
   */
  async processHybridExtraction(puppeteerDataPath, contactJID, contactName) {
    try {
      console.log('🎯 INICIANDO PROCESO HÍBRIDO PUPPETEER + BAILEYS');
      console.log('=' * 60);
      
      // Paso 1: Inicializar Baileys
      console.log('\n📍 PASO 1: Inicializando Baileys...');
      const baileysReady = await this.initializeBaileys();
      if (!baileysReady) {
        throw new Error('No se pudo inicializar Baileys');
      }
      
      // Paso 2: Cargar datos de Puppeteer
      console.log('\n📍 PASO 2: Cargando datos de Puppeteer...');
      const puppeteerLoaded = await this.loadPuppeteerData(puppeteerDataPath);
      if (!puppeteerLoaded) {
        throw new Error('No se pudieron cargar los datos de Puppeteer');
      }
      
      // Paso 3: Buscar mensajes con media en Baileys
      console.log('\n📍 PASO 3: Buscando mensajes con media en Baileys...');
      await this.findMediaMessagesInBaileys(contactJID);
      
      // Paso 4: Correlacionar mensajes
      console.log('\n📍 PASO 4: Correlacionando mensajes...');
      const correlatedMessages = await this.correlateMessages(contactJID);
      
      // Paso 5: Descargar media
      console.log('\n📍 PASO 5: Descargando media con Baileys...');
      const downloadResults = await this.downloadMediaWithBaileys(correlatedMessages, contactName);
      
      // Paso 6: Generar reporte final
      console.log('\n📍 PASO 6: Generando reporte final...');
      const report = await this.generateFinalReport(correlatedMessages, downloadResults, contactName);
      
      console.log('\n🎉 ¡PROCESO HÍBRIDO COMPLETADO EXITOSAMENTE!');
      console.log('=' * 60);
      console.log(`📊 Resumen:`);
      console.log(`   💬 Mensajes totales procesados: ${this.puppeteerData.length}`);
      console.log(`   🖼️ Imágenes descargadas: ${this.downloadStats.images}`);
      console.log(`   📹 Videos descargados: ${this.downloadStats.videos}`);
      console.log(`   ❌ Errores: ${this.downloadStats.errors}`);
      console.log(`   📁 Archivos guardados en: ${report.outputDir}`);
      
      return {
        success: true,
        report: report,
        stats: this.downloadStats
      };
      
    } catch (error) {
      console.error('❌ Error en proceso híbrido:', error);
      return {
        success: false,
        error: error.message,
        stats: this.downloadStats
      };
    }
  }

  /**
   * 📄 Generar reporte final
   */
  async generateFinalReport(correlatedMessages, downloadResults, contactName) {
    const reportDir = path.join(this.config.outputDir, `${contactName}-report`);
    await fs.mkdir(reportDir, { recursive: true });
    
    const report = {
      generatedAt: new Date().toISOString(),
      contactName: contactName,
      totalMessages: this.puppeteerData.length,
      correlatedMessages: correlatedMessages.length,
      downloadedFiles: downloadResults.length,
      outputDir: reportDir,
      puppeteerData: this.puppeteerData,
      downloadResults: downloadResults,
      stats: this.downloadStats
    };
    
    // Guardar reporte completo
    const reportPath = path.join(reportDir, 'hybrid_extraction_report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    // Guardar mensajes enriquecidos (Puppeteer + enlaces a media descargada)
    const enrichedMessages = correlatedMessages.map(corr => {
      const downloadInfo = downloadResults.find(dr => 
        dr.baileysMessageId === corr.baileysMessage?.key?.id
      );
      
      return {
        ...corr.puppeteerData,
        downloadedMedia: downloadInfo || null,
        baileysMessageId: corr.baileysMessage?.key?.id || null
      };
    });
    
    const enrichedPath = path.join(reportDir, 'enriched_messages.json');
    await fs.writeFile(enrichedPath, JSON.stringify(enrichedMessages, null, 2));
    
    console.log(`📄 Reporte guardado en: ${reportPath}`);
    console.log(`📄 Mensajes enriquecidos en: ${enrichedPath}`);
    
    return report;
  }

  /**
   * 🔧 Cerrar conexiones
   */
  async cleanup() {
    if (this.baileysSocket) {
      this.baileysSocket.end();
    }
  }
}

module.exports = HybridWhatsAppScraper;
