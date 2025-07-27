# 🔄 Guía de Sincronización de Chat Completo

## ¿Qué hace la sincronización completa?

La sincronización completa carga **TODO** el historial de un chat específico usando paginación, descargando mensajes antiguos que no están en el historial inicial.

## 📋 Pasos para sincronizar un chat específico:

### 1. **Obtener el JID del chat que quieres sincronizar**

Primero necesitas saber el JID (identificador único) del chat:

```bash
# Obtener lista de todos los chats
GET http://localhost:8000/get-chats
```

### 2. **Sincronizar un chat específico**

```bash
# POST request para sincronizar un chat específico
POST http://localhost:8000/sync-chat-full
Content-Type: application/json

{
  "jid": "521XXXXXXXXXX@s.whatsapp.net",
  "maxMessages": 1000
}
```

### 3. **Sincronizar tu propio chat (chat contigo mismo)**

```bash
# POST request para sincronizar tu chat personal
POST http://localhost:8000/sync-my-chat-full
Content-Type: application/json

{
  "maxMessages": 2000
}
```

### 4. **Sincronizar múltiples chats a la vez**

```bash
# POST request para sincronizar varios chats
POST http://localhost:8000/sync-multiple-chats
Content-Type: application/json

{
  "jids": [
    "521XXXXXXXXXX@s.whatsapp.net",
    "521YYYYYYYYYY@s.whatsapp.net", 
    "120363409784607407@g.us"
  ],
  "maxMessagesPerChat": 500
}
```

### 5. **Ver el progreso de sincronización**

```bash
# GET request para ver estadísticas del chat sincronizado
GET http://localhost:8000/sync-status/521XXXXXXXXXX@s.whatsapp.net
```

## 🔍 Cómo funciona internamente:

1. **Paginación**: Carga mensajes en lotes de 50 usando `loadMessages()`
2. **Cursor**: Usa el último mensaje como cursor para el siguiente lote
3. **Deduplicación**: Evita mensajes duplicados
4. **Ordenamiento**: Ordena todos los mensajes por timestamp
5. **Estadísticas**: Cuenta imágenes, videos, textos, etc.

## 📊 Qué información obtienes:

```json
{
  "status": true,
  "jid": "521XXXXXXXXXX@s.whatsapp.net",
  "stats": {
    "totalMessages": 1250,
    "images": 45,
    "videos": 12,
    "textMessages": 1180,
    "timeRange": {
      "oldest": 1640995200,
      "newest": 1753477818,
      "oldestDate": "2022-01-01T00:00:00.000Z",
      "newestDate": "2025-07-25T12:30:18.000Z"
    }
  }
}
```

## 🖼️ Descarga automática de imágenes

Durante la sincronización, si hay mensajes nuevos con imágenes, se descargarán automáticamente en la carpeta `downloads/`.

## ⚠️ Consideraciones importantes:

1. **Límites**: WhatsApp puede limitar la velocidad de carga
2. **Tiempo**: La sincronización completa puede tomar varios minutos
3. **Memoria**: Muchos mensajes pueden usar mucha RAM
4. **Background**: La sincronización corre en segundo plano

## 🚀 Ejemplo práctico usando curl:

```bash
# 1. Primero conectarte y escanear el QR
curl http://localhost:8000/scan

# 2. Ver estado de conexión
curl http://localhost:8000/session-health

# 3. Ver todos los chats disponibles
curl http://localhost:8000/get-chats

# 4. Sincronizar tu chat personal
curl -X POST http://localhost:8000/sync-my-chat-full \
  -H "Content-Type: application/json" \
  -d '{"maxMessages": 1000}'

# 5. Ver progreso
curl http://localhost:8000/sync-status/120363409784607407@g.us

# 6. Ver historial completo
curl "http://localhost:8000/get-chat-history?jid=120363409784607407@g.us&limit=100"
```

## 📝 Logs de la consola

Durante la sincronización verás logs como:

```
🔄 Iniciando sincronización completa del chat: 521XXXXXXXXXX@s.whatsapp.net
📦 Cargando lote 1 (cursor: inicio)
✅ Lote 1 cargado: 50 mensajes (Total: 50)
📦 Cargando lote 2 (cursor: mensaje_id_123)
✅ Lote 2 cargado: 50 mensajes (Total: 100)
...
🎉 Sincronización completa terminada para 521XXXXXXXXXX@s.whatsapp.net
📊 Total de mensajes cargados: 1250
📈 Estadísticas: 1180 textos, 45 imágenes, 12 videos
```

## 🔧 Troubleshooting

Si la sincronización falla:

1. Verifica que estés conectado: `GET /session-health`
2. Limpia la sesión si hay errores: `POST /clear-session`
3. Reduce el `maxMessages` si es muy lento
4. Revisa los logs de la consola para errores específicos
