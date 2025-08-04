const supabase = require('../supabase');
const path = require('path');
const fs = require('fs');

/**
 * Sube un archivo al storage de Supabase
 * @param {Buffer} buffer - Buffer del archivo
 * @param {string} fileName - Nombre del archivo
 * @param {string} bucket - Nombre del bucket ('whatsapp-images-2' o 'whatsapp-documents')
 * @param {string} folder - Carpeta dentro del bucket (ej: sanitizedJid)
 * @returns {Object} - {success: boolean, url?: string, error?: string}
 */
async function uploadFileToSupabase(buffer, fileName, bucket, folder) {
  try {
    const filePath = `${folder}/${fileName}`;
    
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, buffer, {
        contentType: getContentType(fileName),
        upsert: false // No sobrescribir si existe
      });

    if (error) {
      console.error(`❌ Error subiendo ${fileName} a Supabase:`, error.message);
      return { success: false, error: error.message };
    }

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(filePath);

    console.log(`✅ Archivo subido a Supabase: ${bucket}/${filePath}`);
    
    return { 
      success: true, 
      url: urlData.publicUrl,
      path: filePath,
      bucket: bucket
    };

  } catch (error) {
    console.error(`❌ Error en uploadFileToSupabase:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Descarga un archivo temporalmente desde Supabase para procesamiento
 * @param {string} bucket - Nombre del bucket
 * @param {string} filePath - Ruta del archivo en el bucket
 * @returns {string|null} - Ruta local temporal del archivo descargado
 */
async function downloadFileFromSupabase(bucket, filePath) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .download(filePath);

    if (error) {
      console.error(`❌ Error descargando de Supabase:`, error.message);
      return null;
    }

    // Crear archivo temporal
    const tempDir = path.join(__dirname, '../temp');
    await fs.promises.mkdir(tempDir, { recursive: true });
    
    const tempFileName = `temp_${Date.now()}_${path.basename(filePath)}`;
    const tempFilePath = path.join(tempDir, tempFileName);
    
    // Convertir blob a buffer y guardar
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await fs.promises.writeFile(tempFilePath, buffer);

    console.log(`📥 Archivo temporal creado: ${tempFilePath}`);
    return tempFilePath;

  } catch (error) {
    console.error(`❌ Error en downloadFileFromSupabase:`, error.message);
    return null;
  }
}

/**
 * Elimina archivos temporales
 * @param {string} tempFilePath - Ruta del archivo temporal
 */
async function cleanupTempFile(tempFilePath) {
  try {
    if (fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath);
      console.log(`🧹 Archivo temporal eliminado: ${tempFilePath}`);
    }
  } catch (error) {
    console.error(`⚠️ Error eliminando archivo temporal:`, error.message);
  }
}

/**
 * Obtiene el content-type basado en la extensión del archivo
 * @param {string} fileName - Nombre del archivo
 * @returns {string} - Content-type
 */
function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain'
  };

  return contentTypes[ext] || 'application/octet-stream';
}

/**
 * Lista archivos de un usuario específico
 * @param {string} bucket - Nombre del bucket
 * @param {string} folder - Carpeta (sanitizedJid)
 * @returns {Array} - Lista de archivos
 */
async function listUserFiles(bucket, folder) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(folder);

    if (error) {
      console.error(`❌ Error listando archivos:`, error.message);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error(`❌ Error en listUserFiles:`, error.message);
    return [];
  }
}

module.exports = {
  uploadFileToSupabase,
  downloadFileFromSupabase,
  cleanupTempFile,
  listUserFiles
};