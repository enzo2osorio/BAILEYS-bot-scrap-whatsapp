const os = require('os');

class ResourceMonitor {
  constructor() {
    this.thresholds = {
      memory: {
        warning: 70,  // % de uso de memoria
        critical: 85,
        absolute: 400 * 1024 * 1024 // 400MB en bytes
      },
      cpu: {
        warning: 70,  // % de uso de CPU
        critical: 85
      },
      heap: {
        warning: 200 * 1024 * 1024, // 200MB
        critical: 250 * 1024 * 1024  // 250MB
      }
    };
    
    this.alerts = new Map(); // Prevenir spam de alerts
    this.samples = []; // Historial de muestras
    this.maxSamples = 100;
    
    this.startTime = Date.now();
    this.errorCounts = {
      '428': 0,
      '440': 0,
      'MAC': 0,
      'reconnections': 0,
      'sigterm': 0
    };
  }

  // 📊 Obtener métricas completas del sistema
  getMetrics() {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // CPU Load (promedio 1 minuto)
    const loadAvg = os.loadavg();
    const cpuPercent = Math.min(100, (loadAvg[0] / os.cpus().length) * 100);
    
    const metrics = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      
      // Memoria del proceso Node.js
      heap: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers || 0
      },
      
      // Memoria del sistema
      system: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usagePercent: (usedMem / totalMem) * 100
      },
      
      // CPU
      cpu: {
        percent: cpuPercent,
        loadAverage: loadAvg
      },
      
      // Contadores de errores
      errors: { ...this.errorCounts },
      
      // Handles y conexiones
      handles: process._getActiveHandles?.()?.length || 0,
      requests: process._getActiveRequests?.()?.length || 0
    };
    
    return metrics;
  }

  // 🚨 Verificar si hay alertas necesarias
  checkAlerts(metrics) {
    const alerts = [];
    const now = Date.now();
    
    // Alerta de memoria heap
    if (metrics.heap.used > this.thresholds.heap.critical) {
      if (!this.alerts.has('heap-critical') || now - this.alerts.get('heap-critical') > 300000) {
        alerts.push({
          level: 'CRITICAL',
          type: 'HEAP_MEMORY',
          message: `🔴 Heap crítico: ${(metrics.heap.used / 1024 / 1024).toFixed(1)}MB`,
          value: metrics.heap.used,
          threshold: this.thresholds.heap.critical
        });
        this.alerts.set('heap-critical', now);
      }
    } else if (metrics.heap.used > this.thresholds.heap.warning) {
      if (!this.alerts.has('heap-warning') || now - this.alerts.get('heap-warning') > 600000) {
        alerts.push({
          level: 'WARNING',
          type: 'HEAP_MEMORY',
          message: `🟡 Heap elevado: ${(metrics.heap.used / 1024 / 1024).toFixed(1)}MB`,
          value: metrics.heap.used,
          threshold: this.thresholds.heap.warning
        });
        this.alerts.set('heap-warning', now);
      }
    }
    
    // Alerta de memoria sistema
    if (metrics.system.usagePercent > this.thresholds.memory.critical) {
      if (!this.alerts.has('system-critical') || now - this.alerts.get('system-critical') > 300000) {
        alerts.push({
          level: 'CRITICAL',
          type: 'SYSTEM_MEMORY',
          message: `🔴 Memoria sistema crítica: ${metrics.system.usagePercent.toFixed(1)}%`,
          value: metrics.system.usagePercent,
          threshold: this.thresholds.memory.critical
        });
        this.alerts.set('system-critical', now);
      }
    }
    
    // Alerta de CPU
    if (metrics.cpu.percent > this.thresholds.cpu.critical) {
      if (!this.alerts.has('cpu-critical') || now - this.alerts.get('cpu-critical') > 180000) {
        alerts.push({
          level: 'CRITICAL',
          type: 'CPU_USAGE',
          message: `🔴 CPU crítico: ${metrics.cpu.percent.toFixed(1)}%`,
          value: metrics.cpu.percent,
          threshold: this.thresholds.cpu.critical
        });
        this.alerts.set('cpu-critical', now);
      }
    }
    
    // Alerta de handles/conexiones excesivas
    if (metrics.handles > 50) {
      if (!this.alerts.has('handles') || now - this.alerts.get('handles') > 600000) {
        alerts.push({
          level: 'WARNING',
          type: 'RESOURCE_LEAK',
          message: `🟡 Muchos handles activos: ${metrics.handles} (posible leak)`,
          value: metrics.handles,
          threshold: 50
        });
        this.alerts.set('handles', now);
      }
    }
    
    return alerts;
  }

  // 📈 Almacenar muestra histórica
  storeSample(metrics) {
    this.samples.push({
      timestamp: metrics.timestamp,
      heapMB: Math.round(metrics.heap.used / 1024 / 1024),
      systemPercent: Math.round(metrics.system.usagePercent),
      cpuPercent: Math.round(metrics.cpu.percent),
      handles: metrics.handles,
      errors: { ...metrics.errors }
    });
    
    // Mantener solo las últimas muestras
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  // 📊 Obtener tendencias
  getTrends() {
    if (this.samples.length < 2) return null;
    
    const recent = this.samples.slice(-10); // Últimas 10 muestras
    const older = this.samples.slice(-20, -10); // 10 anteriores
    
    if (older.length === 0) return null;
    
    const recentAvg = {
      heap: recent.reduce((sum, s) => sum + s.heapMB, 0) / recent.length,
      cpu: recent.reduce((sum, s) => sum + s.cpuPercent, 0) / recent.length,
      handles: recent.reduce((sum, s) => sum + s.handles, 0) / recent.length
    };
    
    const olderAvg = {
      heap: older.reduce((sum, s) => sum + s.heapMB, 0) / older.length,
      cpu: older.reduce((sum, s) => sum + s.cpuPercent, 0) / older.length,
      handles: older.reduce((sum, s) => sum + s.handles, 0) / older.length
    };
    
    return {
      heap: {
        trend: recentAvg.heap - olderAvg.heap,
        direction: recentAvg.heap > olderAvg.heap ? '📈' : '📉'
      },
      cpu: {
        trend: recentAvg.cpu - olderAvg.cpu,
        direction: recentAvg.cpu > olderAvg.cpu ? '📈' : '📉'
      },
      handles: {
        trend: recentAvg.handles - olderAvg.handles,
        direction: recentAvg.handles > olderAvg.handles ? '📈' : '📉'
      }
    };
  }

  // 📝 Log formateado de métricas
  logMetrics() {
    const metrics = this.getMetrics();
    const alerts = this.checkAlerts(metrics);
    this.storeSample(metrics);
    
    // Log básico cada vez
    console.log(`📊 Resources - Heap: ${(metrics.heap.used/1024/1024).toFixed(1)}MB | CPU: ${metrics.cpu.percent.toFixed(1)}% | Handles: ${metrics.handles} | Uptime: ${(metrics.uptime/3600).toFixed(1)}h`);
    
    // Mostrar alertas
    alerts.forEach(alert => {
      console.log(`${alert.level === 'CRITICAL' ? '🚨' : '⚠️'} ${alert.message}`);
    });
    
    // Log detallado cada 10 muestras
    if (this.samples.length % 10 === 0) {
      console.log('🔍 Métricas detalladas:');
      console.log(`   💾 Heap: usado=${(metrics.heap.used/1024/1024).toFixed(1)}MB, total=${(metrics.heap.total/1024/1024).toFixed(1)}MB`);
      console.log(`   🖥️  Sistema: ${metrics.system.usagePercent.toFixed(1)}% (${(metrics.system.used/1024/1024/1024).toFixed(1)}GB de ${(metrics.system.total/1024/1024/1024).toFixed(1)}GB)`);
      console.log(`   ⚡ CPU: ${metrics.cpu.percent.toFixed(1)}% | Load: [${metrics.cpu.loadAverage.map(l => l.toFixed(2)).join(', ')}]`);
      console.log(`   🔗 Conexiones: handles=${metrics.handles}, requests=${metrics.requests}`);
      console.log(`   🚨 Errores acum: 428=${metrics.errors['428']}, 440=${metrics.errors['440']}, MAC=${metrics.errors['MAC']}, reconex=${metrics.errors.reconnections}, sigterm=${metrics.errors.sigterm}`);
      
      // Mostrar tendencias si las hay
      const trends = this.getTrends();
      if (trends) {
        console.log(`   📈 Tendencias: Heap ${trends.heap.direction}${trends.heap.trend.toFixed(1)}MB, CPU ${trends.cpu.direction}${trends.cpu.trend.toFixed(1)}%, Handles ${trends.handles.direction}${trends.handles.trend.toFixed(0)}`);
      }
    }
    
    return { metrics, alerts };
  }

  // 📈 Incrementar contador de errores
  incrementError(errorType) {
    const type = String(errorType).toLowerCase();
    if (type.includes('428')) {
      this.errorCounts['428']++;
      console.log(`🔴 Error 428 registrado - Total acumulado: ${this.errorCounts['428']}`);
    } else if (type.includes('440')) {
      this.errorCounts['440']++;
      console.log(`🔴 Error 440 registrado - Total acumulado: ${this.errorCounts['440']}`);
    } else if (type.includes('mac')) {
      this.errorCounts['MAC']++;
      console.log(`🔴 Error MAC registrado - Total acumulado: ${this.errorCounts['MAC']}`);
    } else if (type.includes('reconnect')) {
      this.errorCounts.reconnections++;
      console.log(`🔄 Reconexión registrada - Total acumulado: ${this.errorCounts.reconnections}`);
    } else if (type.includes('sigterm')) {
      this.errorCounts.sigterm++;
      console.log(`🔄 SIGTERM registrado - Total acumulado: ${this.errorCounts.sigterm}`);
    }
  }

  // 💾 Generar reporte completo
  generateReport() {
    const metrics = this.getMetrics();
    const trends = this.getTrends();
    
    return {
      timestamp: metrics.timestamp,
      uptime: metrics.uptime,
      current: {
        heapMB: Math.round(metrics.heap.used / 1024 / 1024),
        systemPercent: Math.round(metrics.system.usagePercent),
        cpuPercent: Math.round(metrics.cpu.percent),
        handles: metrics.handles
      },
      trends: trends,
      errors: metrics.errors,
      samples: this.samples.slice(-20) // Últimas 20 muestras
    };
  }

  // 🧹 Forzar Garbage Collection si está disponible
  forceGarbageCollection() {
    if (global.gc) {
      const beforeGC = process.memoryUsage();
      console.log('🧹 Ejecutando Garbage Collection preventivo...');
      global.gc();
      const afterGC = process.memoryUsage();
      console.log(`   Heap antes: ${(beforeGC.heapUsed/1024/1024).toFixed(1)}MB → después: ${(afterGC.heapUsed/1024/1024).toFixed(1)}MB`);
      return {
        before: beforeGC.heapUsed,
        after: afterGC.heapUsed,
        freed: beforeGC.heapUsed - afterGC.heapUsed
      };
    } else {
      console.log('⚠️ Garbage Collection manual no disponible (ejecuta con --expose-gc)');
      return null;
    }
  }
}

module.exports = ResourceMonitor;