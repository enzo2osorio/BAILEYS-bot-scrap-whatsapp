# 🚀 Guía Rápida: Extractor Automático de Thiago

## ✅ Lo que tienes ahora:

### **Endpoint Principal:**
```
GET http://localhost:8000/sync-data-history
```

### **¿Qué hace automáticamente?**
1. **🎯 Busca el contacto "Thiago"** en tus chats
2. **📱 Extrae los últimos 10 mensajes** de Thiago
3. **🖼️ Descarga automáticamente** todas las imágenes
4. **🎥 Descarga automáticamente** todos los videos
5. **📄 Genera un reporte** con toda la información

---

## 🚀 **Para empezar AHORA:**

### 1. **Inicia el servidor:**
```bash
npm start
```

### 2. **Conecta WhatsApp:**
- Ve a: http://localhost:8000/scan
- Escanea el QR

### 3. **Ejecuta la extracción:**
```bash
# Simplemente visita este endpoint:
http://localhost:8000/sync-data-history
```

**¡Eso es todo!** 🎉

---

## 📊 **¿Qué obtienes?**

### **Archivos generados:**
- 📁 **`./thiago-downloads/`** - Todas las imágenes y videos
- 📄 **`./thiago-extraction-report.json`** - Reporte completo
- 📋 **`./thiago-downloads/download_log.json`** - Log de descargas

### **Ejemplo de reporte:**
```json
{
  "contactName": "Thiago",
  "thiagoJID": "521XXXXXXXXX@s.whatsapp.net",
  "extractionTime": "2025-01-26T15:30:00.000Z",
  "totalMessages": 10,
  "stats": {
    "textMessages": 7,
    "images": 2,
    "videos": 1
  },
  "messages": [...]
}
```

---

## ⚙️ **Configuración del JID de Thiago:**

Si el sistema no encuentra automáticamente a Thiago:

### 1. **Obtén el JID real:**
```bash
curl http://localhost:8000/get-chats
```

### 2. **Edita el código:**
En `index.js`, línea ~1795, reemplaza:
```javascript
thiagoJID = "5219XXXXXXXXX@s.whatsapp.net"; // ⚠️ REEMPLAZA CON EL JID REAL
```

Con el JID real de Thiago que obtuviste del paso 1.

---

## 🔧 **Endpoints adicionales útiles:**

```bash
# Ver estado de la conexión
GET http://localhost:8000/session-health

# Ver todos los chats (para encontrar el JID de Thiago)
GET http://localhost:8000/get-chats

# Ver archivos descargados
GET http://localhost:8000/auto-downloads

# Limpiar descargas
DELETE http://localhost:8000/clear-downloads
```

---

## 🎯 **Personalización rápida:**

### **Cambiar el número de mensajes:**
Edita la función `extractThiagoMessagesAutomatically(10)` y cambia el `10` por el número que quieras.

### **Cambiar el contacto:**
Cambia `"Thiago"` por el nombre del contacto que quieras en la función.

### **Cambiar el directorio de descarga:**
Cambia `'thiago-downloads'` por el directorio que prefieras.

---

## ✅ **¡Listo para usar!**

Solo necesitas:
1. `npm start`
2. Conectar WhatsApp
3. Visitar `http://localhost:8000/sync-data-history`

**¡Todo se hace automáticamente!** 🚀
