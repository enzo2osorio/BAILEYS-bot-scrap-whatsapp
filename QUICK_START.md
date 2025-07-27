# Configuración rápida del Scraper Híbrido

## 1. Iniciar el servidor Baileys
```bash
npm start
```

## 2. Escanear QR en: http://localhost:8000/scan

## 3. Probar el endpoint híbrido:

### Enviar datos de Puppeteer directamente:
```bash
curl -X POST http://localhost:8000/process-puppeteer-data \
  -H "Content-Type: application/json" \
  -d '{
    "puppeteerData": [
      {
        "id": 1,
        "content": "Mensaje de prueba",
        "type": "text",
        "isOwn": false,
        "fullDateTime": "9:00 p.m., 23/7/2025"
      },
      {
        "id": 2,
        "content": "Imagen de prueba",
        "type": "image",
        "isOwn": false,
        "imageUrls": ["blob:url"],
        "fullDateTime": "9:01 p.m., 23/7/2025"
      }
    ],
    "contactJID": "521XXXXXXXXXX@s.whatsapp.net",
    "contactName": "Contacto_Prueba"
  }'
```

### O usar archivo JSON:
```bash
curl -X POST http://localhost:8000/hybrid-extraction \
  -H "Content-Type: application/json" \
  -d '{
    "puppeteerDataPath": "./mi-archivo-puppeteer.json",
    "contactJID": "521XXXXXXXXXX@s.whatsapp.net", 
    "contactName": "Mi_Contacto"
  }'
```

## 4. Monitorear progreso:
```bash
# Ver descargas automáticas
curl http://localhost:8000/auto-downloads

# Ver estado de salud de la sesión
curl http://localhost:8000/session-health
```

## 🎯 Próximos pasos:
1. Adapta tu código de Puppeteer para enviar datos a estos endpoints
2. Crea el mapeo de contactos (nombre → JID)
3. ¡Disfruta de las descargas automáticas en alta calidad!

Para más detalles ver: HYBRID_GUIDE.md
