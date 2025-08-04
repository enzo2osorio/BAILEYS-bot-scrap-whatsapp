const fs = require('fs');
const path = require('path');

/**
 * Limpia archivos de sesión menos críticos para mantener el tamaño bajo control
 * MANTIENE: creds.json, app-state-sync-*, pre-key-* (críticos para la conexión)
 * LIMPIA: sender-key de grupos, sesiones de números no permitidos
 */
const cleanupSessionFiles = async () => {
  const sessionDir = path.join(__dirname, '..', 'session_auth_info');
  
  if (!fs.existsSync(sessionDir)) {
    console.log('📁 Directorio de sesión no existe');
    return;
  }

  const ALLOWED_NUMBERS = [
    '51950306310',
    '5492236849095', 
    '5492234214038'
  ];

  try {
    const files = fs.readdirSync(sessionDir);
    let deletedCount = 0;
    let keptCount = 0;
    let groupKeysDeleted = 0;
    let sessionKeysDeleted = 0;

    console.log(`🔍 Analizando ${files.length} archivos en session_auth_info/`);

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      
      // ✅ NUNCA eliminar archivos críticos
      if (file === 'creds.json' || 
          file.startsWith('app-state-sync-version') ||
          file.startsWith('app-state-sync-key')) {
        keptCount++;
        continue;
      }

      // ✅ Mantener pre-keys (necesarios para la encriptación)
      if (file.startsWith('pre-key-')) {
        keptCount++;
        continue;
      }

      // 🗑️ ELIMINAR: sender-key de grupos (formato: sender-key-{groupId}@g.us--{numbers}--{id}.json)
      if (file.startsWith('sender-key-') && file.includes('@g.us')) {
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
          groupKeysDeleted++;
          if (groupKeysDeleted <= 5) { // Solo mostrar los primeros 5 para no spamear
            console.log(`🗑️ Grupo eliminado: ${file.substring(0, 50)}...`);
          }
        } catch (error) {
          console.error(`❌ Error eliminando ${file}:`, error.message);
        }
        continue;
      }

      // 🔍 ANALIZAR: sesiones individuales (formato: session-{number}.{id}.json)
      if (file.startsWith('session-')) {
        const sessionParts = file.replace('session-', '').replace('.json', '').split('.');
        const sessionNumber = sessionParts[0];
        
        // Eliminar si no está en la lista permitida
        if (!ALLOWED_NUMBERS.includes(sessionNumber)) {
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
            sessionKeysDeleted++;
            console.log(`🗑️ Sesión eliminada: ${file}`);
          } catch (error) {
            console.error(`❌ Error eliminando ${file}:`, error.message);
          }
        } else {
          keptCount++;
          console.log(`✅ Sesión mantenida: ${file}`);
        }
        continue;
      }

      // 🔍 OTROS archivos desconocidos - ser conservador y mantenerlos
      console.log(`❓ Archivo desconocido mantenido: ${file}`);
      keptCount++;
    }

    console.log(`\n🧹 Limpieza completada:`);
    console.log(`   📊 Total archivos: ${files.length}`);
    console.log(`   🗑️ Eliminados: ${deletedCount}`);
    console.log(`   ✅ Mantenidos: ${keptCount}`);
    console.log(`   🏷️ Claves de grupo eliminadas: ${groupKeysDeleted}`);
    console.log(`   📱 Sesiones individuales eliminadas: ${sessionKeysDeleted}`);
    
    if (groupKeysDeleted > 5) {
      console.log(`   ⚡ (+${groupKeysDeleted - 5} claves de grupo más eliminadas)`);
    }
    
  } catch (error) {
    console.error('❌ Error en limpieza de sesión:', error);
  }
};

// Ejecutar limpieza cada 30 minutos (más frecuente para grupos activos)
const startPeriodicCleanup = () => {
  console.log('🕐 Iniciando limpieza periódica de archivos de sesión (cada 30min)...');
  
  // Ejecutar inmediatamente
  cleanupSessionFiles();
  
  // Luego cada 30 minutos
  setInterval(() => {
    console.log('🧹 Ejecutando limpieza programada...');
    cleanupSessionFiles();
  }, 30 * 60 * 1000); // 30 minutos
};

// Función para limpieza más agresiva (manual)
const aggressiveCleanup = async () => {
  const sessionDir = path.join(__dirname, '..', 'session_auth_info');
  
  if (!fs.existsSync(sessionDir)) {
    console.log('📁 Directorio de sesión no existe');
    return;
  }

  try {
    const files = fs.readdirSync(sessionDir);
    let deletedCount = 0;

    console.log('🔥 LIMPIEZA AGRESIVA: Eliminando TODOS los archivos de grupos y sesiones no permitidas');

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      
      // Mantener solo lo absolutamente esencial
      if (file === 'creds.json' || 
          file.startsWith('app-state-sync-version') ||
          file.startsWith('app-state-sync-key')) {
        continue;
      }

      // Eliminar TODO lo demás (incluyendo pre-keys viejos)
      if (file.startsWith('sender-key-') || 
          file.startsWith('session-')) {
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
        } catch (error) {
          console.error(`❌ Error en limpieza agresiva ${file}:`, error.message);
        }
      }
    }

    console.log(`🔥 Limpieza agresiva completada: ${deletedCount} archivos eliminados`);
    console.log('⚠️ Los pre-keys se regenerarán automáticamente en la próxima conexión');
    
  } catch (error) {
    console.error('❌ Error en limpieza agresiva:', error);
  }
};

module.exports = {
  cleanupSessionFiles,
  startPeriodicCleanup,
  aggressiveCleanup
};
