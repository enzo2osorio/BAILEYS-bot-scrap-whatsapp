# 📊 Sistema de Monitoreo de Recursos

## 🎯 Objetivo

Este sistema previene los errores SIGTERM en Render monitoreando recursos en tiempo real y proporcionando alertas tempranas sobre problemas de memoria y rendimiento.

## 🔧 Componentes

### 1. ResourceMonitor Class (`utils/resourceMonitor.js`)
- **Métricas**: Memoria, CPU, uptime, errores
- **Alertas**: Thresholds configurables para memoria y errores
- **Garbage Collection**: Forzado automático cuando está disponible
- **Reportes**: Generación de reportes completos

### 2. Integración en Bot Principal (`index.js`)
- **Tracking de errores**: 428, MAC, 440, SIGTERM
- **Endpoints**: `/health` y `/metrics`
- **Monitoreo automático**: Cada 60s métricas, 30s alertas, 10min GC

### 3. Configuración Render (`render.yaml`)
- **Anti-SIGTERM**: Configuraciones optimizadas
- **Recursos**: Límites y reservas apropiadas
- **Health checks**: Endpoints configurados

## 🚀 Uso

### Comandos Disponibles

```bash
# Desarrollo con monitoreo completo
npm run dev

# Producción optimizada
npm run monitor

# Start normal
npm start
```

### Endpoints de Monitoreo

#### GET /health
```json
{
  "status": "ok",
  "timestamp": "2024-01-XX",
  "uptime": 3600,
  "memory": {...},
  "whatsapp": {...},
  "mongo": {...}
}
```

#### GET /metrics
```json
{
  "success": true,
  "data": {
    "timestamp": "2024-01-XX",
    "uptime": 3600,
    "memory": {
      "used": 45.2,
      "total": 512,
      "percentage": 8.8
    },
    "errors": {
      "error_428": 2,
      "mac": 5,
      "conflict": 1,
      "sigterm": 0
    },
    "alerts": [...],
    "trends": {...}
  }
}
```

## 🔔 Sistema de Alertas

### Tipos de Alerta

1. **MEMORY_HIGH**: Memoria > 80%
2. **ERROR_SPIKE**: > 10 errores/min
3. **GC_NEEDED**: Heap fragmentado
4. **RESOURCE_PRESSURE**: Múltiples métricas elevadas

### Configuración de Thresholds

```javascript
const thresholds = {
  memory: 80,        // % de memoria
  errorRate: 10,     // errores por minuto
  gcInterval: 600000 // 10 minutos
};
```

## 📈 Métricas Monitoreadas

### Memoria
- **RSS**: Memoria residente
- **Heap Total**: Heap asignado
- **Heap Used**: Heap en uso
- **External**: Memoria externa a V8

### Errores
- **error_428**: Rate limiting WhatsApp
- **mac**: Errores de autenticación
- **conflict**: Instancias múltiples (440)
- **sigterm**: Señales de terminación

### Rendimiento
- **Uptime**: Tiempo activo
- **CPU**: Uso de procesador
- **Event Loop Lag**: Retrasos en el loop

## 🛠️ Resolución de Problemas

### Alertas de Memoria Alta

```bash
# Ver métricas actuales
curl http://localhost:3000/metrics

# Forzar garbage collection
curl -X POST http://localhost:3000/gc

# Reiniciar limpio
curl -X POST http://localhost:3000/restart
```

### Picos de Errores

1. **Error 428**: Reduce velocidad de mensajes
2. **MAC Errors**: Verifica integridad de sesión
3. **Conflictos 440**: Asegura una sola instancia

### Prevención SIGTERM

- ✅ **Monitoreo proactivo** cada 30s
- ✅ **GC automático** cada 10min
- ✅ **Alertas tempranas** antes de límites
- ✅ **Configuración optimizada** en render.yaml

## 🔄 Ciclo de Monitoreo

```
Inicio → Configuración → Monitoreo Continuo
    ↓           ↓              ↓
Métricas ← Alertas ← Garbage Collection
    ↓           ↓              ↓
Logs → Endpoint /metrics → Reportes
```

## 📊 Dashboard Sugerido

Para visualización externa, usa los endpoints:
- **Uptime Robot**: Monitor `/health` cada 5min
- **Grafana**: Scrape `/metrics` cada 1min
- **Logs**: Búsqueda por "🚨 ALERTA"

## 🎛️ Configuración Avanzada

### Variables de Entorno

```bash
# Límites de memoria
MAX_OLD_SPACE_SIZE=512
NODE_OPTIONS="--max-old-space-size=512 --expose-gc"

# Frecuencia de monitoreo
MONITOR_INTERVAL=60000
ALERT_INTERVAL=30000
GC_INTERVAL=600000
```

### Personalizar Thresholds

Edita `utils/resourceMonitor.js`:

```javascript
constructor() {
  this.thresholds = {
    memory: 85,     // Más estricto
    errorRate: 5,   // Más sensible
    gcTrigger: 70   // GC más frecuente
  };
}
```

## 🎯 Objetivos del Sistema

1. **Prevenir SIGTERM**: Detectar problemas antes que Render
2. **Optimizar memoria**: GC inteligente y alertas
3. **Diagnosticar**: Métricas detalladas y trends
4. **Automatizar**: Monitoreo sin intervención manual

---

> **Nota**: Este sistema es específicamente diseñado para prevenir los problemas de SIGTERM identificados en Render, donde la acumulación de errores y memoria causa terminaciones del proceso.