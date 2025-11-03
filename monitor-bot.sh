#!/bin/bash

# 🩺 Script de monitoreo externo para prevenir SIGTERM en Render
# Usar con GitHub Actions o cron job externo

BOT_URL="https://tu-bot-render.onrender.com"
HEALTH_ENDPOINT="$BOT_URL/health"
RECOVERY_ENDPOINT="$BOT_URL/force-recovery/tu-access-key"

echo "🔍 Verificando estado del bot..."

# Hacer health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_ENDPOINT")

if [ "$HTTP_CODE" -eq 200 ]; then
    echo "✅ Bot funcionando correctamente (HTTP $HTTP_CODE)"
    
    # Ping adicional para mantener actividad
    curl -s "$BOT_URL/" > /dev/null
    echo "📡 Ping enviado para mantener actividad"
    
elif [ "$HTTP_CODE" -eq 0 ] || [ "$HTTP_CODE" -ge 500 ]; then
    echo "🚨 Bot no responde (HTTP $HTTP_CODE), intentando recovery..."
    
    # Intentar recovery automático
    RECOVERY_RESPONSE=$(curl -s "$RECOVERY_ENDPOINT")
    echo "🔄 Recovery response: $RECOVERY_RESPONSE"
    
    # Esperar y verificar nuevamente
    sleep 30
    NEW_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_ENDPOINT")
    
    if [ "$NEW_CODE" -eq 200 ]; then
        echo "✅ Recovery exitoso (HTTP $NEW_CODE)"
    else
        echo "❌ Recovery falló (HTTP $NEW_CODE)"
        # Aquí podrías enviar alerta por email/Slack
    fi
else
    echo "⚠️ Bot responde pero con estado inusual (HTTP $HTTP_CODE)"
fi

echo "📊 Monitoreo completado - $(date)"