const {
  default: makeWASocket,
  DisconnectReason,
  makeInMemoryStore,
  useMultiFileAuthState,
  downloadMediaMessage,
  getContentType,
  Browsers,
} = require("@whiskeysockets/baileys");
const log = (pino = require("pino"));
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const openAI = require("openai");
const vision = require("@google-cloud/vision");
const destinatarios = require('./similarDestinatarios');
const matchDestinatario = require('./utils/findMatchDestinatario');
const supabase = require('./supabase');
const saveDataFirstFlow = require("./saveDataFirstFlow");
const getCategorias = require('./utils/getCategorias')
const getSubcategorias = require('./utils/getSubcategorias');
const saveNewDestinatario = require('./utils/saveNewDestinatario');

dotenv.config();


// TODO: AGREGAR ESTADOS PARA MANEJAR EL METODO DE PAGO PARECIDO AL MANEJO DE DESTINATARIO.
// 🔄 SISTEMA DE ESTADO PERSISTENTE POR USUARIO
const stateMap = new Map();
const TIMEOUT_DURATION = 3 * 60 * 1000; // 3 minutos en milisegundos

// Estados posibles del flujo
const STATES = {
  IDLE: "idle",
  AWAITING_DESTINATARIO_CONFIRMATION: "awaiting_destinatario_confirmation",
  AWAITING_DESTINATARIO_SECOND_TRY: "awaiting_destinatario_second_try",
  AWAITING_DESTINATARIO_CHOOSING_IN_LIST_OR_ADDING_NEW: "awaiting_destinatario_choosing_in_list_or_adding_new", 
  AWAITING_NEW_DESTINATARIO_NAME: "awaiting_new_destinatario_name",
  AWAITING_CATEGORY_SELECTION: "awaiting_category_selection",
  AWAITING_SUBCATEGORY_SELECTION: "awaiting_subcategory_selection",
  AWAITING_SAVE_CONFIRMATION: "awaiting_save_confirmation",
  AWAITING_MODIFICATION_SELECTION: "awaiting_modification_selection",
  AWAITING_DESTINATARIO_MODIFICATION: "awaiting_destinatario_modification",
  AWAITING_MONTO_MODIFICATION: "awaiting_monto_modification",
  AWAITING_FECHA_MODIFICATION: "awaiting_fecha_modification",
  AWAITING_TIPO_MOVIMIENTO_MODIFICATION: "awaiting_tipo_movimiento_modification",
  AWAITING_MEDIO_PAGO_MODIFICATION: "awaiting_medio_pago_modification"
};

const { session } = { session: "session_auth_info" };
const app = express();
app.use(
  fileUpload({
    createParentPath: true,
  })
);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const port = process.env.PORT || 8000;
const qrcode = require("qrcode");

app.use("/assets", express.static(__dirname + "/client/assets"));

app.get("/scan", (req, res) => {
  res.sendFile("./client/index.html", {
    root: __dirname,
  });
});

app.get("/", (req, res) => {
  res.send("server working");
});

let sock;
let qrDinamic;
let soket;

// Variable temporal para almacenar mensajes en memoria
let messageStore = {};
let contactStore = {};
let chatStore = {};

// Función para crear el store de Baileys
const initStore = () => {
  try {
    if (typeof makeInMemoryStore === "function") {
      const store = makeInMemoryStore({ logger: log({ level: "debug" }) });
      store.readFromFile("./baileys_store.json");

      // Guardar el store cada 10 segundos
      setInterval(() => {
        store.writeToFile("./baileys_store.json");
      }, 10_000);

      return store;
    }
  } catch (error) {
    console.log("makeInMemoryStore no disponible, usando store manual");
  }
  return null;
};

  const store = initStore();

// 🔄 FUNCIONES PARA MANEJO DE ESTADO PERSISTENTE
const setUserState = (jid, state, data = {}) => {
  // Limpiar timeout anterior si existe
  const currentState = stateMap.get(jid);
  if (currentState?.timeout) {
    console.log("current state timeout");
    clearTimeout(currentState.timeout);
  }

  // Crear nuevo timeout
  const timeout = setTimeout(() => {
    clearUserState(jid);
    sock.sendMessage(jid, {
      text: "⏰ El flujo se ha cancelado por inactividad (3 minutos). Envía un nuevo comprobante para comenzar nuevamente."
    }).catch(console.error);
  }, TIMEOUT_DURATION);

  stateMap.set(jid, {
    state,
    data,
    timestamp: Date.now(),
    timeout
  });

  console.log(`🔄 Estado de ${jid} cambiado a: ${state}`);
};

const getUserState = (jid) => {
  return stateMap.get(jid) || { state: STATES.IDLE, data: {}, timestamp: null, timeout: null };
};

const clearUserState = (jid) => {
  const currentState = stateMap.get(jid);
  if (currentState?.timeout) {
    clearTimeout(currentState.timeout);
  }
  stateMap.delete(jid);
  console.log(`🧹 Estado de ${jid} limpiado`);
};



const getMetodosPago = async () => {
  try {
    console.log("🔍 Intentando obtener métodos de pago de Supabase...");
    
    const { data, error } = await supabase
      .from('metodos_pago')
      .select('id, name')
      .order('name');
    
    if (error) {
      console.error("❌ Error en Supabase getMetodosPago:", error);
      throw error;
    }
    
    console.log(`✅ Métodos de pago obtenidos: ${data?.length || 0}`);
    if (data?.length > 0) {
      console.log("📋 Métodos de pago:", data.map(m => `${m.id}: ${m.name}`).join(', '));
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error obteniendo métodos de pago:', error.message);
    return [];
  }
};

// 📨 FUNCIONES PARA MENSAJES (botones eliminados, solo texto ahora)
// Función para limpiar sesiones corruptas
const clearCorruptedSession = async () => {
  try {
    const sessionPath = path.join(__dirname, "session_auth_info");
    if (fs.existsSync(sessionPath)) {
      console.log("🧹 Limpiando sesión corrupta...");
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(
        "✅ Sesión limpiada. Será necesario escanear el QR nuevamente."
      );
    }

    // También limpiar el store de Baileys si existe
    const storePath = path.join(__dirname, "baileys_store.json");
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
      console.log("✅ Store de Baileys limpiado.");
    }
  } catch (error) {
    console.error("❌ Error limpiando sesión:", error);
  }
};

// �️ CONTADOR DE ERRORES MAC PARA AUTO-LIMPIEZA
let macErrorCount = 0;
let lastMacErrorReset = Date.now();

// �🔧 FUNCIÓN MEJORADA PARA MANEJAR ERRORES DE DESCIFRADO
const handleDecryptionError = (error, jid) => {
  if (error.message?.includes("Bad MAC")) {
    macErrorCount++;
    
    // Reset contador cada 5 minutos
    if (Date.now() - lastMacErrorReset > 300000) {
      macErrorCount = 0;
      lastMacErrorReset = Date.now();
    }
    
    // Si hay más de 100 errores MAC en 5 minutos, algo está mal
    if (macErrorCount > 100) {
      console.log(`⚠️ Demasiados errores MAC (${macErrorCount}) - puede necesitar limpiar sesión`);
      console.log(`💡 Si el problema persiste, ejecuta: POST /clear-session`);
      macErrorCount = 0; // Reset para evitar spam
    }
    
    return true; // Indica que el error fue manejado
  }
  if (error.message?.includes("Failed to decrypt")) {
    return true;
  }
  return false; // Error no manejado
};

// 🛡️ FUNCIÓN PARA MANEJAR ERRORES DE SESIÓN
const handleSessionError = async (error) => {
  console.log("🔍 Analizando error de sesión:", error.message);
  
  if (error.message?.includes("Bad MAC") || 
      error.message?.includes("Session error") ||
      error.message?.includes("Failed to decrypt")) {
    
    console.log("⚠️ Detectados múltiples errores de MAC - posible sesión corrupta");
    console.log("🔄 Esto es normal durante la sincronización inicial o reconexión");
    
    // No cerrar la sesión inmediatamente por errores MAC
    // Solo registrar y continuar
    return false; // No requiere reconexión
  }
  
  return true; // Otros errores pueden requerir reconexión
};

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("session_auth_info");

  sock = makeWASocket({
    auth: state,
    logger: log({ level: "silent" }),
    syncFullHistory: false, // ⚠️ CRÍTICO: Mantener en false para evitar errores MAC
    markOnlineOnConnect: false,
    browser: Browsers.windows("Desktop"),
    cachedGroupMetadata: true,
    // 🛡️ CONFIGURACIONES OPTIMIZADAS PARA REDUCIR ERRORES MAC
    retryRequestDelayMs: 5000, // 5 segundos entre reintentos
    maxMsgRetryCount: 1, // Solo 1 reintento para evitar loops
    fireInitQueries: false, // ⚠️ CRÍTICO: Deshabilitar queries iniciales
    emitOwnEvents: false,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    // 🔧 TIMEOUTS OPTIMIZADOS
    connectTimeoutMs: 30000, // 30 segundos
    defaultQueryTimeoutMs: 20000, // 20 segundos
    keepAliveIntervalMs: 60000, // 1 minuto keep alive
    // 🛡️ MANEJO DE ERRORES DE DESCIFRADO
    getMessage: async (key) => {
      // No intentar recuperar mensajes que causan errores MAC
      return undefined;
    }
  });

  // Vincular el store al socket si está disponible
  if (store) {
    store.bind(sock.ev);
  }

  // 🛡️ LISTENER PARA CAPTURAR ERRORES MAC Y EVITAR SPAM EN CONSOLA
  const originalEmit = sock.ev.emit;
  sock.ev.emit = function(event, ...args) {
    try {
      return originalEmit.call(this, event, ...args);
    } catch (error) {
      if (error.message?.includes("Bad MAC") || 
          error.message?.includes("Failed to decrypt")) {
        // Silenciosamente ignorar errores MAC para evitar spam
        return;
      }
      // Re-lanzar otros errores
      throw error;
    }
  };

  // 🛡️ AGREGAR MANEJO DE ERRORES GLOBAL PARA EL SOCKET
  sock.ev.on('error', (error) => {
    if (error.message?.includes("Bad MAC")) {
      // No hacer nada, estos errores son comunes durante la sincronización
      return;
    }
    console.error("⚠️ Error en socket:", error.message);
  });

  // 🛡️ LISTENER PARA MANEJAR ERRORES GLOBALES DEL SOCKET
  sock.ev.on('error', async (error) => {
    console.log("🔍 Error capturado en socket:", error.message?.substring(0, 100));
    
    const needsReconnect = await handleSessionError(error);
    if (needsReconnect) {
      console.log("🔄 Error crítico detectado, programando reconexión...");
      setTimeout(() => {
        connectToWhatsApp().catch(err => console.log("Error en reconexión:", err));
      }, 5000); // Esperar 5 segundos antes de reconectar
    }
  });

  // 🛡️ LISTENER PARA MANEJAR ERRORES DE DESCIFRADO
  sock.ev.on('CB:Msg,server', async (node) => {
    try {
      // Procesar mensaje normalmente
    } catch (error) {
      if (error.message?.includes("Bad MAC")) {
        console.log("⚠️ Error MAC en mensaje - continuando...");
        return; // Ignorar error y continuar
      }
      throw error; // Re-lanzar otros errores
    }
  });

  // 📝 LISTENER PRINCIPAL - MENSAJES NUEVOS CON SISTEMA DE ESTADO PERSISTENTE
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
      
    for (const msg of messages) {
      try {
        if (!msg.message || !msg.key?.remoteJid) continue;

        const jid = msg.key.remoteJid;
        const messageId = msg.key.id;
        const senderName = contactStore[jid]?.name || jid.split("@")[0];
        const timestamp = msg.messageTimestamp || Math.floor(Date.now() / 1000);
        const messageType = getContentType(msg.message);
        console.log({messageType})
        console.log(`📩 Nuevo mensaje de ${senderName} (${jid})`);

        // Solo procesar mensajes de números específicos
        if (jid === "51950306310@s.whatsapp.net" || jid === "5492236849095@s.whatsapp.net" || jid === "5492234214038@s.whatsapp.net") {
          console.log({msg});
          // 🔄 Verificar estado actual del usuario
          const userState = getUserState(jid);
          console.log(`🔍 Estado actual de ${senderName}: ${userState.state}`);

          // Esta sección ya no es necesaria - ahora usamos números en lugar de botones

          // 📝 MANEJO DE MENSAJES DE TEXTO SEGÚN ESTADO
          if (messageType === "conversation" || messageType === "extendedTextMessage") {
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            
            // Manejar confirmaciones numeradas para destinatarios
            if (userState.state === STATES.AWAITING_DESTINATARIO_CONFIRMATION) {
              await handleDestinationConfirmation(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_DESTINATARIO_SECOND_TRY) {
              await handleSecondDestinationConfirmation(jid, textMessage, userState, msg);
              continue;
            }
            if (userState.state === STATES.AWAITING_DESTINATARIO_CHOOSING_IN_LIST_OR_ADDING_NEW) {
              await handleChoosingInListOrAddingNew(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_NEW_DESTINATARIO_NAME) {
              await handleNewDestinatarioName(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_CATEGORY_SELECTION) {
              await handleCategoryNumberSelection(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_SUBCATEGORY_SELECTION) {
              await handleSubcategoryNumberSelection(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_SAVE_CONFIRMATION) {
              await handleSaveConfirmation(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MODIFICATION_SELECTION) {
              await handleModificationSelection(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_DESTINATARIO_MODIFICATION) {
              await handleChoosingInListOrAddingNew(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MONTO_MODIFICATION) {
              await handleMontoModification(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_FECHA_MODIFICATION) {
              await handleFechaModification(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_TIPO_MOVIMIENTO_MODIFICATION) {
              await handleTipoMovimientoModification(jid, textMessage, userState, msg);
              continue;
            }
            
            if (userState.state === STATES.AWAITING_MEDIO_PAGO_MODIFICATION) {
              await handleMedioPagoModification(jid, textMessage, userState, msg);
              continue;
            }
          }

          // 🖼️ PROCESAMIENTO INICIAL DE COMPROBANTES (solo si está en estado IDLE)
          if (userState.state === STATES.IDLE) {
            let captureMessage = "";
            let caption = "";
            let imagePath = "";

            if (messageType === "imageMessage") {
              caption = msg.message.imageMessage.caption || "";

              // 🖼️ Descargar imagen primero
              imagePath = await downloadImageMessage(msg, senderName, messageId);
              console.log(`📥 Imagen descargada en: ${imagePath}`);
              
              // 🔍 Extraer texto desde imagen
              const extractedText = await extractTextFromImage(imagePath);

              // 💡 Combinar caption + texto OCR
              captureMessage = [caption, extractedText].filter(Boolean).join("\n\n");
            } else if (messageType === "documentWithCaptionMessage") {
              // 📄 Manejo de documentos (PDFs, etc.)
              const documentCaption = msg.message.documentWithCaptionMessage.caption || "";
              const fileName = msg.message.documentWithCaptionMessage.message?.documentMessage?.fileName || "";
              const paraDepurar = msg.message.documentWithCaptionMessage
              console.log({paraDepurar})
              console.log(`📄 Documento recibido: ${fileName}`);
              
              // 📥 Descargar documento
              const documentPath = await downloadDocumentMessage(msg, senderName, messageId);
              
              if (documentPath) {
                // 🔍 Intentar extraer texto del documento
                const extractedDocumentText = await extractTextFromDocument(documentPath, fileName);
                captureMessage = [documentCaption, extractedDocumentText].filter(Boolean).join("\n\n");
              } else {
                // Si no se pudo descargar, usar solo el caption
                captureMessage = documentCaption;
              }
            } else if (messageType === "conversation") {
              captureMessage = msg.message.conversation || "";
            } else if (messageType === "extendedTextMessage") {
              captureMessage = msg.message.extendedTextMessage.text || "";
            }

            // 🧠 Procesar con OpenAI si hay algo que analizar
            if (captureMessage.trim()) {
              await processInitialMessage(jid, captureMessage, caption, msg);
            }
          } else {
            // Si el usuario tiene un estado activo pero envía algo inesperado
            await sock.sendMessage(jid, {
              text: "⚠️ Tienes un flujo activo. Responde a la pregunta anterior o espera 3 minutos para que se cancele automáticamente."
            });
          }
        }
      } catch (err) {
        if (err.message?.includes("Bad MAC")) {
          console.log(`⚠️ Bad MAC en mensaje ${msg.key?.id}`);
        } else {
          console.error(`❌ Error general en mensaje:`, err.message);
        }
      }
    }
  });

  // 🔄 FUNCIONES DE MANEJO DE FLUJO CONVERSACIONAL

  // 🧠 Procesar mensaje inicial con OpenAI
  const processInitialMessage = async (jid, captureMessage, caption, quotedMsg) => {
    try {
      const client = new openAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      const response = await client.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Eres un asistente que interpreta comprobantes de pago, documentos financieros y mensajes breves para extraer información contable en formato estructurado.

### 📥 Entrada:
Recibirás **un único texto combinado** que puede tener las siguientes secciones:
1. **Caption/Mensaje**: Texto ingresado manualmente por el usuario en WhatsApp (suele estar al inicio).
2. **OCR de imagen**: Texto extraído automáticamente de imágenes mediante reconocimiento óptico de caracteres.
3. **Contenido de documento**: Texto extraído de documentos PDF, facturas digitales, etc.
4. **Indicadores de documento**: Mensajes como "[Documento PDF recibido: factura.pdf]" cuando no se pudo extraer texto.

Todas las partes estarán separadas por **dos saltos de línea** (\n\n) y se deben considerar **en conjunto** para extraer la información.

Ejemplo de entrada con documento:

Pago a proveedor - Mes de Julio

[Documento PDF recibido: factura_julio_2025.pdf]

Transferencia realizada
CBU: 000123456789
Alias: proveedor.com
Monto: $15.500
Fecha: 27/07/2025
Hora: 14:30

### 🎯 Tu objetivo:
Analizar todo el texto recibido y construir un objeto JSON con los siguientes campos:

{
  "nombre": string | null,          // Nombre de la persona o entidad involucrada
  "monto": number | null,           // Monto en pesos argentinos, sin símbolos
  "fecha": string | null,           // Formato: "dd/mm/yyyy"
  "hora": string | null,            // Formato: "hh:mm" (24 horas)
  "tipo_movimiento": string | null, // Solo "ingreso" o "egreso"
  "medio_pago": string | null,      // Ej: "Mercado Pago", "Transferencia", "Efectivo"
  "referencia": string | null,      // Código de referencia si existe
  "numero_operacion": string | null,// Número de operación o comprobante
  "observacion": string | null      // Notas o contexto adicional
}

### Indicaciones clave:

- **"tipo_movimiento"** puede ser solo: "ingreso" o "egreso".
  
- La **fecha** debe estar en formato "dd/mm/yyyy" y la hora en "hh:mm" (24 horas).
  
- El **proveedor** es generalmente quien **recibe el dinero** cuando se trata de un **egreso**, y es muy importante identificarlo.

### Criterios para deducir el tipo de movimiento:

- Si el remitente (quien envía el dinero) es **Erica Romina Davila** o **Nicolas Olave**, es muy probable que sea un **egreso**.
  
- Si el receptor (quien recibe el dinero) es **Erica Romina Davila** o **Nicolas Olave**, es probable que sea un **ingreso**.

- Si en alguna parte del texto se menciona "pago", "pagaste a", "transferencia" o similares, es probable que sea un **egreso**.
- Si en alguna parte del texto se relaciona fuertemente "pagador" con "Olave" o "Davila", es probable que sea un **egreso**.


- Si en alguna parte del texto se menciona "devolucion", "reembolso" o similares, es probable que sea un **ingreso**.

> Estos criterios no son absolutos: en algunos casos puede haber excepciones.

### Manejo de documentos:

- Si recibes un **documento PDF** (indicado por "[Documento PDF recibido: nombre.pdf]"), significa que el usuario envió un archivo adjunto.
- En estos casos, prioriza la información del **caption/mensaje del usuario** y cualquier texto extraído del documento.
- Si el documento no pudo ser procesado completamente, solicita al usuario que incluya **fecha** y **tipo de movimiento** en el mensaje de acompañamiento.
- Los PDFs suelen contener facturas, recibos o comprobantes oficiales, así que trata de identificar **números de factura** o **códigos de referencia**.

### Contexto adicional:

- El sistema se utiliza en Mar del Plata, Argentina. El dinero está expresado en pesos argentinos.
- Si hay dudas razonables sobre algún campo, trata de devolver algun resultado adecuado, pero si no hay exacta certeza, devuelve null.
- Usa el campo "observacion" para notas relevantes, alias de nombres, u otra información contextual.

Responde únicamente con el JSON, sin texto adicional.
`
                },
                {
                  role: "user",
                  content: captureMessage
                }
              ]
            });

            const jsonString = response.choices[0].message.content.trim();
            console.log("🤖 Respuesta OpenAI estructurada:", jsonString)

            let data;
            try {
              data = JSON.parse(jsonString);
            } catch (err) {
              console.error("Error al parsear JSON de OpenAI:", err);
              data = {};
            }

      const destinatarioName = data.nombre || "Desconocido";
      console.log({ destinatarioName });

      // Buscar coincidencia de destinatario (IMPORTANTE: usar await porque es async)
      const destinatarioMatch = await matchDestinatario(destinatarioName);
          
      if (destinatarioMatch.clave) {
        console.log("✅ Destinatario encontrado:", { destinatarioMatch });
        
        // Guardar estado y datos
        setUserState(jid, STATES.AWAITING_DESTINATARIO_CONFIRMATION, {
          structuredData: data,
          destinatarioMatch,
          caption,
          originalData: data
        });

        // Enviar pregunta de confirmación con lista numerada
        await sock.sendMessage(jid, {
          text: `✅ El destinatario es *${destinatarioMatch.clave}*\n\n¿Es correcto?\n\n1. Sí\n2. No\n3. Cancelar\n\nEscribe el número de tu opción:`
        }, { quoted: quotedMsg });

      } else {
        console.log("❌ No se encontró destinatario, intentando con caption...");
        // No se encontró coincidencia, intentar con caption
        await trySecondDestinatarioMatch(jid, caption, data, quotedMsg);
      }

    } catch (error) {
      console.error("❌ Error con OpenAI:", error.message);
      await sock.sendMessage(jid, {
        text: "Ocurrió un error interpretando el mensaje."
      }, { quoted: quotedMsg });
    }
  };

  // 🔍 Segundo intento de coincidencia con caption
  const trySecondDestinatarioMatch = async (jid, caption, structuredData, quotedMsg) => {
    const nameInCaption = caption.split('-')[0].trim();
    const destinatarioFromCaption = await matchDestinatario(nameInCaption, destinatarios);
    
    if (destinatarioFromCaption.clave) {
      console.log("✅ Destinatario encontrado en segundo intento:", { destinatarioFromCaption });
      
      setUserState(jid, STATES.AWAITING_DESTINATARIO_SECOND_TRY, {
        structuredData,
        destinatarioMatch: destinatarioFromCaption,
        caption,
        originalData: structuredData
      });

      await sock.sendMessage(jid, {
        text: `🔍 Segundo intento: El destinatario es *${destinatarioFromCaption.clave}*\n\n¿Es correcto?\n\n1. Sí\n2. No\n3. Cancelar\n\nEscribe el número de tu opción:`
      }, { quoted: quotedMsg });
    } else {
      console.log("❌ No se encontró destinatario en segundo intento, mostrando lista completa...");
      // Mostrar lista completa de destinatarios en lugar de crear uno nuevo directamente
      await showAllDestinatariosList(jid, structuredData);
    }
  };

  // 📝 Iniciar flujo de nuevo destinatario
  const startNewDestinatarioFlow = async (jid, structuredData) => {
    setUserState(jid, STATES.AWAITING_NEW_DESTINATARIO_NAME, {
      structuredData: structuredData.isModification ? null : structuredData,
      finalStructuredData: structuredData.isModification ? structuredData : null,
      isModification: structuredData.isModification || false,
      originalData: structuredData
    });

    await sock.sendMessage(jid, {
      text: "🆕 Vamos a crear un nuevo destinatario.\n\nEscribe el nombre canónico del destinatario:"
    });
  };

  // 🔘 Manejar confirmación de destinatario (primera vez)
  const handleDestinationConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Sí
        await proceedToFinalConfirmation(jid, userState.data.destinatarioMatch.clave, userState.data.structuredData);
        break;
      case 2: // No
        await trySecondDestinatarioMatch(jid, userState.data.caption, userState.data.structuredData, quotedMsg);
        break;
      case 3: // Cancelar
        await sock.sendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };

  // 🔘 Manejar confirmación de destinatario (segundo intento)
  const handleSecondDestinationConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Sí
        await proceedToFinalConfirmation(jid, userState.data.destinatarioMatch.clave, userState.data.structuredData);
        break;
      case 2: // No
        await showAllDestinatariosList(jid, userState.data.structuredData);
        break;
      case 3: // Cancelar
        await sock.sendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };

  // 📋 Mostrar lista completa de destinatarios
  const showAllDestinatariosList = async (jid, structuredData) => {
    try {
      // Obtener todos los destinatarios de la base de datos
      const { data: allDestinatarios, error } = await supabase
        .from('destinatarios')
        .select('id, name')
        .order('name');

        console.log({allDestinatarios})

      if (error) {
        console.error("Error obteniendo destinatarios:", error);
        await sock.sendMessage(jid, { text: "❌ Error obteniendo la lista de destinatarios." });
        clearUserState(jid);
        return;
      }

      if (!allDestinatarios || allDestinatarios.length === 0) {
        await sock.sendMessage(jid, { text: "📋 No hay destinatarios registrados. Procederemos a crear uno nuevo." });
        await startNewDestinatarioFlow(jid, structuredData);
        return;
      }

      // Crear lista numerada (empezando desde 2)
      let destinatarioList = "0. ❌ Cancelar\n1. ➕ Nuevo destinatario\n";
      allDestinatarios.forEach((dest, index) => {
        destinatarioList += `${index + 2}. ${dest.name}\n`;
      });

      // Guardar estado con los destinatarios disponibles
      setUserState(jid, STATES.AWAITING_DESTINATARIO_CHOOSING_IN_LIST_OR_ADDING_NEW, {
        structuredData,
        allDestinatarios,
        originalData: structuredData
      });

      await sock.sendMessage(jid, {
        text: `📋 *Lista completa de destinatarios:*\n\n${destinatarioList}\nEscribe el número del destinatario que corresponde:`
      });

    } catch (error) {
      console.error("Error en showAllDestinatariosList:", error);
      await sock.sendMessage(jid, { text: "❌ Error mostrando la lista de destinatarios." });
      clearUserState(jid);
    }
  };

  // 🔄 Manejar selección de la lista completa de destinatarios
  const handleChoosingInListOrAddingNew = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    console.log(`🔍 Opción seleccionada: ${option}`);
    const allDestinatarios = userState.data.allDestinatarios;
    console.log({allDestinatarios})
    const maxOption = allDestinatarios.length + 1; // +1 porque empezamos desde el índice 2
    const isModification = userState.data.isModification || false;

    if (isNaN(option) || option < 0 || option > maxOption) {
      await sock.sendMessage(jid, { 
        text: `⚠️ Por favor, escribe un número válido (0 a ${maxOption}).` 
      });
      return;
    }

    switch (option) {
      case 0: // Cancelar
        if (isModification) {
          await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
        } else {
          await sock.sendMessage(jid, { text: "❌ Operación cancelada." });
          clearUserState(jid);
        }
        break;
        
      case 1: // Nuevo destinatario
        const dataForNewDestinatario = isModification 
          ? { ...userState.data.finalStructuredData, isModification: true }
          : userState.data.structuredData;
        await startNewDestinatarioFlow(jid, dataForNewDestinatario);
        break;
        
      default: // Destinatario seleccionado (índices 2 en adelante)
        const selectedIndex = option - 2; // Convertir a índice del array (0-based)
        if (selectedIndex >= 0 && selectedIndex < allDestinatarios.length) {
          const selectedDestinatario = allDestinatarios[selectedIndex];
          console.log(`✅ Destinatario seleccionado: ${selectedDestinatario.name}`);

          if (isModification) {
            // Actualizar destinatario en modificación
            const updatedData = {
              ...userState.data.finalStructuredData,
              nombre: selectedDestinatario.name
            };
            console.log('🔧 Destinatario actualizado en modificación:', {
              anterior: userState.data.finalStructuredData.nombre,
              nuevo: selectedDestinatario.name,
              updatedData: updatedData
            });
            await sock.sendMessage(jid, { text: `✅ Destinatario actualizado a: ${selectedDestinatario.name}` });
            await proceedToFinalConfirmationFromModification(jid, updatedData);
          } else {
            // Flujo normal
            await proceedToFinalConfirmation(jid, selectedDestinatario.name, userState.data.structuredData);
          }
        } else {
          await sock.sendMessage(jid, { text: "⚠️ Opción no válida. Intenta nuevamente." });
        }
        break;
    }
  };

  // 🔘 Manejar confirmación de guardado
  const handleSaveConfirmation = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 1 || option > 3) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (1, 2 o 3)." });
      return;
    }

    switch (option) {
      case 1: // Guardar
        await saveComprobante(jid, userState.data);
        break;
      case 2: // Modificar
        await showModificationMenu(jid, userState.data);
        break;
      case 3: // Cancelar
        await sock.sendMessage(jid, { text: "❌ Operación cancelada." });
        clearUserState(jid);
        break;
    }
  };

  // 📝 Manejar nombre de nuevo destinatario
  const handleNewDestinatarioName = async (jid, textMessage, userState, quotedMsg) => {
    const nombreCanonico = textMessage.trim();
    
    if (!nombreCanonico) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, ingresa un nombre válido." });
      return;
    }

    // Actualizar datos con el nombre
    const updatedData = { 
      ...userState.data, 
      newDestinatarioName: nombreCanonico 
    };

    setUserState(jid, STATES.AWAITING_CATEGORY_SELECTION, updatedData);

    // Obtener y mostrar categorías
    const categorias = await getCategorias();
    
    if (categorias.length === 0) {
      await sock.sendMessage(jid, { text: "❌ No se pudieron cargar las categorías. Intenta más tarde." });
      clearUserState(jid);
      return;
    }

    // Crear lista numerada de categorías
    const categoryList = categorias.map((cat, index) => 
      `${index + 1}. ${cat.name}`
    ).join('\n');

    // Guardar categorías en el estado para mapear el número luego
    const updatedDataWithCategories = {
      ...updatedData,
      availableCategories: categorias
    };
    setUserState(jid, STATES.AWAITING_CATEGORY_SELECTION, updatedDataWithCategories);

    await sock.sendMessage(jid, {
      text: `✅ Nombre guardado: *${nombreCanonico}*\n\n📂 Elige una categoría escribiendo el número:\n\n${categoryList}\n\nEscribe solo el número de la categoría que deseas.`
    });
  };

  // � Manejar selección numérica de categoría
  const handleCategoryNumberSelection = async (jid, textMessage, userState, quotedMsg) => {
    const categoryNumber = parseInt(textMessage.trim());
    
    if (isNaN(categoryNumber) || categoryNumber < 1) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe un número válido de la lista." });
      return;
    }

    const categories = userState.data.availableCategories;
    if (!categories || categoryNumber > categories.length) {
      await sock.sendMessage(jid, { text: "⚠️ Número fuera de rango. Elige un número de la lista." });
      return;
    }

    const selectedCategory = categories[categoryNumber - 1];
    console.log(`✅ Categoría seleccionada: ${selectedCategory.nombre} (ID: ${selectedCategory.id})`);
    
    await handleCategorySelection(jid, selectedCategory.id, userState.data);
  };

  // 🔢 Manejar selección numérica de subcategoría
  const handleSubcategoryNumberSelection = async (jid, textMessage, userState, quotedMsg) => {
    const subcategoryNumber = parseInt(textMessage.trim());
    
    if (isNaN(subcategoryNumber) || subcategoryNumber < 1) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe un número válido de la lista." });
      return;
    }

    const subcategories = userState.data.availableSubcategories;
    if (!subcategories || subcategoryNumber > subcategories.length) {
      await sock.sendMessage(jid, { text: "⚠️ Número fuera de rango. Elige un número de la lista." });
      return;
    }

    const selectedSubcategory = subcategories[subcategoryNumber - 1];
    console.log(`✅ Subcategoría seleccionada: ${selectedSubcategory.nombre} (ID: ${selectedSubcategory.id})`);
    
    await handleSubcategorySelection(jid, selectedSubcategory.id, userState.data);
  };

  // �📂 Manejar selección de categoría
  const handleCategorySelection = async (jid, categoriaId, userData) => {
    const subcategorias = await getSubcategorias(categoriaId);
    
    if (subcategorias.length === 0) {
      await sock.sendMessage(jid, { text: "⚠️ No hay subcategorías disponibles para esta categoría." });
      return;
    }

    const updatedData = { 
      ...userData, 
      selectedCategoriaId: categoriaId,
      availableSubcategories: subcategorias 
    };

    setUserState(jid, STATES.AWAITING_SUBCATEGORY_SELECTION, updatedData);

    // Crear lista numerada de subcategorías
    const subcategoryList = subcategorias.map((subcat, index) => 
      `${index + 1}. ${subcat.name}`
    ).join('\n');

    await sock.sendMessage(jid, {
      text: `� Ahora elige una subcategoría escribiendo el número:\n\n${subcategoryList}\n\nEscribe solo el número de la subcategoría que deseas.`
    });
  };

  // 📁 Manejar selección de subcategoría
  const handleSubcategorySelection = async (jid, subcategoriaId, userData) => {
    // Guardar nuevo destinatario
    const newDestinatario = await saveNewDestinatario(
      userData.newDestinatarioName,
      userData.selectedCategoriaId,
      subcategoriaId
    );

    if (!newDestinatario) {
      await sock.sendMessage(jid, { text: "❌ Error guardando el destinatario. Intenta más tarde." });
      clearUserState(jid);
      return;
    }

    await sock.sendMessage(jid, { 
      text: `✅ Destinatario *${userData.newDestinatarioName}* creado exitosamente.` 
    });

    // Verificar si estamos en modo modificación
    const isModification = userData.isModification || userData.finalStructuredData;
    
    if (isModification) {
      // Actualizar destinatario en los datos existentes para modificación
      const updatedData = {
        ...userData.finalStructuredData,
        nombre: userData.newDestinatarioName
      };
      console.log('🔧 Nuevo destinatario creado en modificación:', userData.newDestinatarioName);
      await proceedToFinalConfirmationFromModification(jid, updatedData);
    } else {
      // Flujo normal - crear nueva entrada
      await proceedToFinalConfirmation(jid, userData.newDestinatarioName, userData.structuredData);
    }
  };

  // ✅ Proceder a confirmación final
  const proceedToFinalConfirmation = async (jid, destinatarioName, structuredData) => {
    const finalData = {
      ...structuredData,
      nombre: destinatarioName
    };

    setUserState(jid, STATES.AWAITING_SAVE_CONFIRMATION, {
      finalStructuredData: finalData
    });

    await sock.sendMessage(jid, {
      text: `📋 *Datos del comprobante:*\n\n` +
      `👤 *Destinatario:* ${destinatarioName}\n` +
      `💰 *Monto:* $${finalData.monto || 'No especificado'}\n` +
      `📅 *Fecha:* ${finalData.fecha || 'No especificada'}\n` +
      `🕐 *Hora:* ${finalData.hora || 'No especificada'}\n` +
      `📊 *Tipo:* ${finalData.tipo_movimiento || 'No especificado'}\n` +
      `💳 *Medio de pago:* ${finalData.medio_pago || 'No especificado'}\n\n` +
      `¿Deseas guardar estos datos?\n\n1. 💾 Guardar\n2. ✏️ Modificar\n3. ❌ Cancelar\n\nEscribe el número de tu opción:`
    });
  };

  // 💾 Guardar comprobante final
  const saveComprobante = async (jid, userData) => {
    try {
      // Aquí llamarías a tu función de guardado existente
      console.log({userData})
      const result = await saveDataFirstFlow(userData.finalStructuredData);

      console.log({result})
      if (result.success) {
        await sock.sendMessage(jid, { 
          text: "✅ Comprobante guardado exitosamente." 
        });
      } else {
        await sock.sendMessage(jid, { 
          text: "❌ Error guardando el comprobante. Intenta más tarde." 
        });
      }

      clearUserState(jid);
    } catch (error) {
      console.error("Error guardando comprobante:", error);
      await sock.sendMessage(jid, { 
        text: "❌ Error guardando el comprobante." 
      });
      clearUserState(jid);
    }
  };

  // 📝 Mostrar menú de modificación
  const showModificationMenu = async (jid, userData) => {
    setUserState(jid, STATES.AWAITING_MODIFICATION_SELECTION, userData);

    await sock.sendMessage(jid, {
      text: `📝 ¿Qué deseas modificar?\n\n` +
      `0. ❌ Cancelar\n` +
      `1. 👤 Destinatario\n` +
      `2. 💰 Monto\n` +
      `3. 📅 Fecha\n` +
      `4. 📊 Tipo de movimiento\n` +
      `5. 💳 Medio de pago\n\n` +
      `Escribe el número de tu opción:`
    });
  };

  // 🔘 Manejar selección de modificación
  const handleModificationSelection = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (isNaN(option) || option < 0 || option > 5) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe un número válido (0 a 5)." });
      return;
    }

    switch (option) {
      case 0: // Cancelar - volver a confirmación
        await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
        break;
      case 1: // Destinatario
        await showDestinatariosForModification(jid, userState.data);
        break;
      case 2: // Monto
        setUserState(jid, STATES.AWAITING_MONTO_MODIFICATION, userState.data);
        await sock.sendMessage(jid, {
          text: "💰 Escribe el nuevo monto (solo números, sin puntos, sin comas, sin símbolos):\n\nEjemplo: 14935\n\nEscribe 0 para cancelar."
        });
        break;
      case 3: // Fecha
        setUserState(jid, STATES.AWAITING_FECHA_MODIFICATION, userState.data);
        await sock.sendMessage(jid, {
          text: "📅 Escribe la nueva fecha en formato dd/mm/yyyy:\n\nEjemplo: 15/08/2025\n\nEscribe 0 para cancelar."
        });
        break;
      case 4: // Tipo de movimiento
        setUserState(jid, STATES.AWAITING_TIPO_MOVIMIENTO_MODIFICATION, userState.data);
        await sock.sendMessage(jid, {
          text: "📊 Escribe el tipo de movimiento:\n\n1. ingreso\n2. egreso\n\nEscribe 0 para cancelar."
        });
        break;
      case 5: // Medio de pago
        await showMediosPagoForModification(jid, userState.data);
        break;
    }
  };

  // 👤 Mostrar destinatarios para modificación
  const showDestinatariosForModification = async (jid, userData) => {
    try {
      const { data: allDestinatarios, error } = await supabase
        .from('destinatarios')
        .select('id, name')
        .order('name');

      if (error) {
        console.error("Error obteniendo destinatarios:", error);
        await sock.sendMessage(jid, { text: "❌ Error obteniendo la lista de destinatarios." });
        await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
        return;
      }

      if (!allDestinatarios || allDestinatarios.length === 0) {
        await sock.sendMessage(jid, { text: "📋 No hay destinatarios registrados." });
        await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
        return;
      }

      let destinatarioList = "0. ❌ Cancelar\n1. ➕ Nuevo destinatario\n";
      allDestinatarios.forEach((dest, index) => {
        destinatarioList += `${index + 2}. ${dest.name}\n`;
      });

      setUserState(jid, STATES.AWAITING_DESTINATARIO_MODIFICATION, {
        ...userData,
        allDestinatarios,
        isModification: true
      });

      await sock.sendMessage(jid, {
        text: `👤 *Selecciona el nuevo destinatario:*\n\n${destinatarioList}\nEscribe el número del destinatario:`
      });

    } catch (error) {
      console.error("Error en showDestinatariosForModification:", error);
      await sock.sendMessage(jid, { text: "❌ Error mostrando destinatarios." });
      await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
    }
  };

  // 💳 Mostrar métodos de pago para modificación
  const showMediosPagoForModification = async (jid, userData) => {
    try {
      const metodosPago = await getMetodosPago();
      
      if (metodosPago.length === 0) {
        await sock.sendMessage(jid, { text: "❌ No se pudieron cargar los métodos de pago." });
        await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
        return;
      }

      let metodosList = "0. ❌ Cancelar\n";
      metodosPago.forEach((metodo, index) => {
        metodosList += `${index + 1}. ${metodo.name}\n`;
      });

      setUserState(jid, STATES.AWAITING_MEDIO_PAGO_MODIFICATION, {
        ...userData,
        availableMetodosPago: metodosPago
      });

      await sock.sendMessage(jid, {
        text: `💳 *Selecciona el nuevo método de pago:*\n\n${metodosList}\nEscribe el número del método de pago:`
      });

    } catch (error) {
      console.error("Error en showMediosPagoForModification:", error);
      await sock.sendMessage(jid, { text: "❌ Error mostrando métodos de pago." });
      await proceedToFinalConfirmationFromModification(jid, userData.finalStructuredData);
    }
  };

  // 💰 Manejar modificación de monto
  const handleMontoModification = async (jid, textMessage, userState, quotedMsg) => {
    const input = textMessage.trim();
    
    if (input === "0") {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    const monto = parseFloat(input);
    if (isNaN(monto) || monto <= 0) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, ingresa un monto válido (solo números)." });
      return;
    }

    // Actualizar monto en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      monto: monto
    };

    await sock.sendMessage(jid, { text: `✅ Monto actualizado a: $${monto}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // 📅 Manejar modificación de fecha
  const handleFechaModification = async (jid, textMessage, userState, quotedMsg) => {
    const input = textMessage.trim();
    
    if (input === "0") {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    // Validar formato dd/mm/yyyy
    const fechaRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
    if (!fechaRegex.test(input)) {
      await sock.sendMessage(jid, { text: "⚠️ Formato incorrecto. Usa dd/mm/yyyy (ej: 15/08/2025)" });
      return;
    }

    // Actualizar fecha en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      fecha: input
    };

    await sock.sendMessage(jid, { text: `✅ Fecha actualizada a: ${input}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // 📊 Manejar modificación de tipo de movimiento
  const handleTipoMovimientoModification = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (option === 0) {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    if (isNaN(option) || option < 1 || option > 2) {
      await sock.sendMessage(jid, { text: "⚠️ Por favor, escribe 1 (ingreso), 2 (egreso) o 0 (cancelar)." });
      return;
    }

    const tipoMovimiento = option === 1 ? "ingreso" : "egreso";
    
    // Actualizar tipo de movimiento en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      tipo_movimiento: tipoMovimiento
    };

    await sock.sendMessage(jid, { text: `✅ Tipo de movimiento actualizado a: ${tipoMovimiento}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // 💳 Manejar modificación de método de pago
  const handleMedioPagoModification = async (jid, textMessage, userState, quotedMsg) => {
    const option = parseInt(textMessage.trim());
    
    if (option === 0) {
      await proceedToFinalConfirmationFromModification(jid, userState.data.finalStructuredData);
      return;
    }

    const metodosPago = userState.data.availableMetodosPago;
    if (isNaN(option) || option < 1 || option > metodosPago.length) {
      await sock.sendMessage(jid, { 
        text: `⚠️ Por favor, escribe un número válido (0 a ${metodosPago.length}).` 
      });
      return;
    }

    const selectedMetodo = metodosPago[option - 1];
    
    // Actualizar método de pago en los datos
    const updatedData = {
      ...userState.data.finalStructuredData,
      medio_pago: selectedMetodo.name
    };

    await sock.sendMessage(jid, { text: `✅ Método de pago actualizado a: ${selectedMetodo.name}` });
    await proceedToFinalConfirmationFromModification(jid, updatedData);
  };

  // ✅ Volver a confirmación final desde modificación
  const proceedToFinalConfirmationFromModification = async (jid, finalData) => {
    console.log('🔧 Datos recibidos en proceedToFinalConfirmationFromModification:', finalData);
    
    setUserState(jid, STATES.AWAITING_SAVE_CONFIRMATION, {
      finalStructuredData: finalData
    });

    await sock.sendMessage(jid, {
      text: `📋 *Datos del comprobante (actualizados):*\n\n` +
      `👤 *Destinatario:* ${finalData.nombre || 'No especificado'}\n` +
      `💰 *Monto:* $${finalData.monto || 'No especificado'}\n` +
      `📅 *Fecha:* ${finalData.fecha || 'No especificada'}\n` +
      `🕐 *Hora:* ${finalData.hora || 'No especificada'}\n` +
      `📊 *Tipo:* ${finalData.tipo_movimiento || 'No especificado'}\n` +
      `💳 *Medio de pago:* ${finalData.medio_pago || 'No especificado'}\n\n` +
      `¿Deseas guardar estos datos?\n\n1. 💾 Guardar\n2. ✏️ Modificar\n3. ❌ Cancelar\n\nEscribe el número de tu opción:`
    });
  };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    qrDinamic = qr;
    if (connection === "close") {
      let reason = new Boom(lastDisconnect.error).output.statusCode;
      if (reason === DisconnectReason.badSession) {
        console.log(
          `Bad Session File, Please Delete ${session} and Scan Again`
        );
        // Limpiar sesión corrupta
        await clearCorruptedSession();
        sock.logout();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("Conexión cerrada, reconectando....");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("Conexión perdida del servidor, reconectando...");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "Conexión reemplazada, otra nueva sesión abierta, cierre la sesión actual primero"
        );
        sock.logout();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(
          `Dispositivo cerrado, elimínelo ${session} y escanear de nuevo.`
        );
        await clearCorruptedSession();
        sock.logout();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("Se requiere reinicio, reiniciando...");
        connectToWhatsApp();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("Se agotó el tiempo de conexión, conectando...");
        connectToWhatsApp();
      } else {
        console.log(
          `Motivo de desconexión desconocido: ${reason}|${lastDisconnect.error}`
        );
        // Si hay errores repetidos de MAC, limpiar la sesión
        if (lastDisconnect.error?.message?.includes("Bad MAC")) {
          console.log("Error de MAC detectado, limpiando sesión...");
          await clearCorruptedSession();
        }
        sock.end();
      }
    } else if (connection === "open") {
      console.log("conexión abierta");

    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on(
    "messaging-history.set",
    async ({ chats, contacts, messages, syncType }) => {
      console.log("syncType:", syncType);
      console.log(`Chats ${chats.length}, msgs ${messages.length}`);
      await fs.writeFile(
        "history.json",
        JSON.stringify({ chats, contacts, messages }, null, 2)
      );
      for (const m of messages) {
        console.log(
          `msg ${m.key.id} from ${m.key.remoteJid}`,
          m.message?.imageMessage ? "📷" : ""
        );
        if (m.message?.imageMessage) {
          const buf = await downloadMediaMessage(m, "buffer");
          await fs.writeFile(`img-${m.key.id}.jpg`, buf);
        }
      }
    }
  );
}

// 🖼️ FUNCIÓN PARA DESCARGAR IMAGEN DE MENSAJE
async function downloadImageMessage(message, senderName, messageId) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      // Obtener el JID del remitente para crear carpeta específica
      const senderJid = message.key.remoteJid || senderName;
      const sanitizedJid = senderJid.replace(/[@.:]/g, "_");

      // Crear directorio de descargas organizado por usuario
      const downloadsDir = path.join(__dirname, "downloads");
      const userDownloadsDir = path.join(downloadsDir, sanitizedJid);
      await fs.promises.mkdir(userDownloadsDir, { recursive: true });

      // Obtener información del archivo
      const timestamp =
        message.messageTimestamp || Math.floor(Date.now() / 1000);
      const mimetype = message.message.imageMessage.mimetype || "image/jpeg";

      let extension = ".jpg";
      if (mimetype.includes("png")) extension = ".png";
      else if (mimetype.includes("gif")) extension = ".gif";
      else if (mimetype.includes("webp")) extension = ".webp";

      // Crear nombre de archivo único (más simple ya que está en carpeta específica)
      const fileName = `${timestamp}_${messageId}${extension}`;
      const filePath = path.join(userDownloadsDir, fileName);

      // Guardar archivo
      await fs.promises.writeFile(filePath, buffer);

      console.log(`📸 Imagen guardada: ${sanitizedJid}/${fileName}`);

      const trueFilePath = `../downloads/${sanitizedJid}/${fileName}`;

      return trueFilePath; // Retornar ruta completa para el log
    }

    return null;
  } catch (error) {
    console.error(`Error descargando imagen ${messageId}:`, error.message);
    return null;
  }
}

// � FUNCIÓN PARA DESCARGAR DOCUMENTO DE MENSAJE
async function downloadDocumentMessage(message, senderName, messageId) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      // Obtener el JID del remitente para crear carpeta específica
      const senderJid = message.key.remoteJid || senderName;
      const sanitizedJid = senderJid.replace(/[@.:]/g, "_");

      // Crear directorio de descargas organizado por usuario
      const downloadsDir = path.join(__dirname, "downloads");
      const userDownloadsDir = path.join(downloadsDir, sanitizedJid);
      await fs.promises.mkdir(userDownloadsDir, { recursive: true });

      // Obtener información del archivo
      const timestamp = message.messageTimestamp || Math.floor(Date.now() / 1000);
      
      // Determinar la estructura correcta del documento
      let documentData = null;
      if (message.message.documentMessage) {
        // Documento directo
        documentData = message.message.documentMessage;
      } else if (message.message.documentWithCaptionMessage?.message?.documentMessage) {
        // Documento con caption
        documentData = message.message.documentWithCaptionMessage.message.documentMessage;
      }
      
      const fileName = documentData?.fileName || `document_${messageId}`;
      const mimetype = documentData?.mimetype || "application/octet-stream";

      // Determinar extensión
      let extension = path.extname(fileName);
      if (!extension) {
        if (mimetype.includes("pdf")) extension = ".pdf";
        else if (mimetype.includes("doc")) extension = ".doc";
        else if (mimetype.includes("excel") || mimetype.includes("sheet")) extension = ".xlsx";
        else extension = ".bin";
      }

      // Crear nombre de archivo único
      const finalFileName = `${timestamp}_${messageId}_${path.basename(fileName, path.extname(fileName))}${extension}`;
      const filePath = path.join(userDownloadsDir, finalFileName);

      // Guardar archivo
      await fs.promises.writeFile(filePath, buffer);

      console.log(`📄 Documento guardado: ${sanitizedJid}/${finalFileName}`);
      console.log(`📝 Tipo: ${mimetype}, Tamaño: ${buffer.length} bytes`);

      return filePath; // Retornar ruta absoluta
    }

    return null;
  } catch (error) {
    console.error(`Error descargando documento ${messageId}:`, error.message);
    return null;
  }
}

// �📁 FUNCIÓN GENERAL PARA DESCARGAR CUALQUIER MEDIA ORGANIZADA POR USUARIO
async function downloadMediaByUser(message, messageType, senderJid, messageId) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      // Sanitizar JID para crear carpeta específica
      const sanitizedJid = senderJid.replace(/[@.:]/g, "_");

      // Crear directorio de descargas organizado por usuario
      const downloadsDir = path.join(__dirname, "downloads");
      const userDownloadsDir = path.join(downloadsDir, sanitizedJid);
      await fs.promises.mkdir(userDownloadsDir, { recursive: true });

      // Obtener información del archivo según el tipo
      const timestamp =
        message.messageTimestamp || Math.floor(Date.now() / 1000);
      let extension = "";
      let prefix = "";
      let mimetype = "";

      switch (messageType) {
        case "imageMessage":
          mimetype = message.message.imageMessage.mimetype || "image/jpeg";
          prefix = "img";
          if (mimetype.includes("png")) extension = ".png";
          else if (mimetype.includes("gif")) extension = ".gif";
          else if (mimetype.includes("webp")) extension = ".webp";
          else extension = ".jpg";
          break;

        case "videoMessage":
          mimetype = message.message.videoMessage.mimetype || "video/mp4";
          prefix = "vid";
          if (mimetype.includes("webm")) extension = ".webm";
          else if (mimetype.includes("avi")) extension = ".avi";
          else if (mimetype.includes("mov")) extension = ".mov";
          else extension = ".mp4";
          break;

        case "audioMessage":
          mimetype = message.message.audioMessage.mimetype || "audio/ogg";
          prefix = "aud";
          if (mimetype.includes("mp3")) extension = ".mp3";
          else if (mimetype.includes("wav")) extension = ".wav";
          else if (mimetype.includes("m4a")) extension = ".m4a";
          else extension = ".ogg";
          break;

        case "documentMessage":
          const fileName =
            message.message.documentMessage.fileName || "document";
          mimetype =
            message.message.documentMessage.mimetype ||
            "application/octet-stream";
          prefix = "doc";
          extension = path.extname(fileName) || ".bin";
          break;

        default:
          prefix = "media";
          extension = ".bin";
      }

      // Crear nombre de archivo único
      const fileName = `${prefix}_${timestamp}_${messageId}${extension}`;
      const filePath = path.join(userDownloadsDir, fileName);

      // Guardar archivo
      await fs.promises.writeFile(filePath, buffer);

      console.log(`📁 ${messageType} guardado: ${sanitizedJid}/${fileName}`);

      return filePath;
    }

    return null;
  } catch (error) {
    console.error(
      `Error descargando ${messageType} ${messageId}:`,
      error.message
    );
    return null;
  }
}

// 📝 FUNCIÓN PARA GUARDAR MENSAJE EN LOG JSON POR CHAT
async function saveMessageToLog(messageData) {
  try {
    // Crear carpeta de logs si no existe
    const logsDir = path.join(__dirname, "chat-logs");
    await fs.promises.mkdir(logsDir, { recursive: true });

    // Crear nombre de archivo seguro basado en el JID
    const sanitizedJid = messageData.sender.replace(/[@.:]/g, "_");
    const logPath = path.join(logsDir, `${sanitizedJid}.json`);

    let messages = [];

    // Leer log existente del chat específico
    if (fs.existsSync(logPath)) {
      try {
        const existingData = await fs.promises.readFile(logPath, "utf8");
        messages = JSON.parse(existingData);
      } catch (error) {
        console.log(`Creando nuevo log para ${messageData.senderName}...`);
        messages = [];
      }
    }

    // 🔍 VERIFICAR DUPLICADOS ANTES DE AGREGAR
    const existingMsg = messages.find((msg) => msg.id === messageData.id);
    if (existingMsg) {
      console.log(`⚠️ Mensaje ${messageData.id} ya existe, evitando duplicado`);
      return; // No guardar si ya existe
    }

    // Agregar nuevo mensaje
    messages.push(messageData);

    // Ordenar mensajes por timestamp para mantener orden cronológico
    messages.sort((a, b) => a.timestamp - b.timestamp);

    // Mantener solo los últimos 2000 mensajes por chat para no llenar el disco
    if (messages.length > 2000) {
      messages = messages.slice(-2000);
    }

    // Guardar log actualizado del chat específico
    await fs.promises.writeFile(logPath, JSON.stringify(messages, null, 2));

    console.log(
      `📝 Mensaje guardado en log de ${messageData.senderName}: ${messageData.type} (${messages.length} mensajes total)`
    );
  } catch (error) {
    console.error("Error guardando mensaje en log:", error.message);
  }
}

const isConnected = () => {
  return sock?.user ? true : false;
};

// 🔧 Cliente de Vision (usando detección automática de credenciales)
let visionClient = null;
try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Verificar que el archivo de credenciales exista en la ruta especificada
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!fs.existsSync(credentialsPath)) {
      console.error(`❌ Archivo de credenciales no encontrado en: ${credentialsPath}`);
      console.log("⚠️ GOOGLE_APPLICATION_CREDENTIALS configurada, pero el archivo no existe.");
    } else {
      visionClient = new vision.ImageAnnotatorClient();
      console.log("✅ Google Vision cliente inicializado con credenciales automáticas.");
    }
  } else {
    console.log("⚠️ GOOGLE_APPLICATION_CREDENTIALS no configurada - OCR deshabilitado.");
    console.log("💡 Configura la variable de entorno apuntando a tu archivo JSON de credenciales.");
  }
} catch (error) {
  console.warn("⚠️ Error inicializando Google Vision:", error.message);
  console.log("💡 Verifica que el archivo de credenciales existe y es válido.");
}

const extractTextFromImage = async (imagePath) => {
  try {
    if (!visionClient) {
      console.log("⚠️ Google Vision no disponible - retornando texto vacío");
      console.log("💡 Configura GOOGLE_APPLICATION_CREDENTIALS en tu archivo .env");
      return "";
    }

    let correctedImagePath = imagePath;

     if (imagePath.startsWith('../')) {
      // 2. Reemplaza "../" por "./"
      //    substring(3) obtiene la cadena a partir del tercer carácter,
      //    eliminando los primeros tres caracteres ("../").
      //    Luego, le añadimos "./" al principio.
      correctedImagePath = `./${imagePath.substring(3)}`;
      console.log(`🔧 Ruta de imagen corregida: '${imagePath}' -> '${correctedImagePath}'`);
    } else {
      // Si no empieza con '../', asumimos que ya está bien o es una ruta absoluta.
      console.log(`📸 Usando ruta de imagen tal cual: '${correctedImagePath}'`);
    }
    // Verificar que el archivo existe
    if (!fs.existsSync(correctedImagePath)) {
      console.error(`❌ Archivo de imagen no encontrado: ${correctedImagePath}`);
      return "";
    }

    console.log(`🔍 Analizando imagen con Google Vision: ${correctedImagePath}`);
    const [result] = await visionClient.textDetection(correctedImagePath);
    const detections = result.textAnnotations;
    
    if (detections && detections.length > 0) {
      const fullText = detections[0].description || "";
      console.log(`📄 Texto detectado (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");
      return fullText;
    } else {
      console.log("📄 No se detectó texto en la imagen");
      return "";
    }
  } catch (err) {
    console.error("❌ Error en Vision OCR:", err.message);
    
    // Proporcionar sugerencias específicas según el tipo de error
    if (err.message.includes("authentication")) {
      console.log("💡 Error de autenticación - verifica tu archivo de credenciales");
    } else if (err.message.includes("quota")) {
      console.log("💡 Error de cuota - verifica los límites de tu proyecto Google Cloud");
    } else if (err.message.includes("API")) {
      console.log("💡 Error de API - verifica que Vision API esté habilitada en Google Cloud");
    }
    
    return "";
  }
};

// 📄 FUNCIÓN PARA EXTRAER TEXTO DE DOCUMENTOS (PDFs, etc.)
const extractTextFromDocument = async (documentPath, fileName) => {
  try {
    console.log(`📄 Intentando extraer texto de documento: ${fileName}`);
    
    const fileExtension = path.extname(fileName).toLowerCase();
    
    // 🔍 Estrategia 1: Para PDFs, intentar con pdf-parse si está disponible
    if (fileExtension === '.pdf') {
      try {
        // Intentar cargar pdf-parse dinámicamente
        const pdfParse = require('pdf-parse');
        const dataBuffer = await fs.promises.readFile(documentPath);
        const pdfData = await pdfParse(dataBuffer);
        
        if (pdfData.text && pdfData.text.trim()) {
          console.log(`✅ Texto extraído de PDF (${pdfData.text.length} caracteres):`, pdfData.text.substring(0, 200) + "...");
          return pdfData.text;
        }
      } catch (pdfError) {
        console.log("⚠️ pdf-parse no disponible o falló, intentando con Vision API...");
      }
    }
    
    // 🔍 Estrategia 2: Convertir a imagen y usar Google Vision (para PDFs y otros)
    if (visionClient && fileExtension === '.pdf') {
      try {
        // Para PDFs, Google Vision puede procesarlos directamente
        console.log(`🔍 Analizando PDF con Google Vision: ${documentPath}`);
        const [result] = await visionClient.textDetection(documentPath);
        const detections = result.textAnnotations;
        
        if (detections && detections.length > 0) {
          const fullText = detections[0].description || "";
          console.log(`📄 Texto detectado en PDF (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");
          return fullText;
        }
      } catch (visionError) {
        console.log("⚠️ Google Vision falló con PDF:", visionError.message);
      }
    }
    
    // 🔍 Estrategia 3: Para otros tipos de documento, mensaje informativo
    if (fileExtension !== '.pdf') {
      console.log(`ℹ️ Tipo de documento no soportado para extracción: ${fileExtension}`);
      return `[Documento ${fileExtension.toUpperCase()} recibido: ${fileName}]`;
    }
    
    console.log("📄 No se pudo extraer texto del documento");
    return `[Documento PDF recibido: ${fileName}]`;
    
  } catch (error) {
    console.error("❌ Error extrayendo texto de documento:", error.message);
    return `[Error procesando documento: ${fileName}]`;
  }
};

// Función para obtener el historial de mensajes de un chat específico
const getChatHistory = async (jid, limit = 50) => {
  try {
    if (!sock) {
      throw new Error("Socket no conectado");
    }

    // Obtener mensajes de nuestro store temporal (incluye historial)
    const messages = messageStore[jid] || [];
    const limitedMessages = messages.slice(-limit).reverse();

    // Procesar mensajes para agregar información útil
    const processedMessages = limitedMessages.map((msg) => {
      const processed = { ...msg };

      // Agregar información del tipo de mensaje
      if (msg.message) {
        const messageType = getContentType(msg.message);
        processed.messageType = messageType;

        // Si es una imagen, agregar información de descarga
        if (messageType === "imageMessage") {
          processed.mediaInfo = {
            type: "image",
            mimetype: msg.message.imageMessage?.mimetype,
            url: msg.message.imageMessage?.url,
            caption: msg.message.imageMessage?.caption,
            hasMedia: true,
          };
        }

        // Si es un video
        if (messageType === "videoMessage") {
          processed.mediaInfo = {
            type: "video",
            mimetype: msg.message.videoMessage?.mimetype,
            url: msg.message.videoMessage?.url,
            caption: msg.message.videoMessage?.caption,
            hasMedia: true,
          };
        }

        // Si es un documento
        if (messageType === "documentMessage") {
          processed.mediaInfo = {
            type: "document",
            mimetype: msg.message.documentMessage?.mimetype,
            fileName: msg.message.documentMessage?.fileName,
            hasMedia: true,
          };
        }

        // Si es audio
        if (messageType === "audioMessage") {
          processed.mediaInfo = {
            type: "audio",
            mimetype: msg.message.audioMessage?.mimetype,
            hasMedia: true,
          };
        }
      }

      return processed;
    });

    return processedMessages;
  } catch (error) {
    console.error("Error obteniendo historial:", error);
    return [];
  }
};

// Función para cargar mensajes con paginación (como el ejemplo que proporcionaste)
const loadMessagesWithPagination = async (jid, count = 25, cursor = null) => {
  try {
    if (!sock || !sock.loadMessages) {
      throw new Error("loadMessages no disponible");
    }

    const messages = await sock.loadMessages(jid, count, cursor);

    // Agregar los mensajes al store
    if (messages && messages.length > 0) {
      if (!messageStore[jid]) {
        messageStore[jid] = [];
      }

      messages.forEach((msg) => {
        const existingMsg = messageStore[jid].find(
          (m) => m.key.id === msg.key.id
        );
        if (!existingMsg) {
          messageStore[jid].unshift(msg); // Agregar al inicio (son más antiguos)
        }
      });

      // Reordenar por timestamp
      messageStore[jid].sort(
        (a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0)
      );
    }

    return messages;
  } catch (error) {
    console.error("Error cargando mensajes con paginación:", error);
    return [];
  }
};

// Función para descargar todas las imágenes de un chat
const downloadAllImagesFromChat = async (jid, maxImages = 50) => {
  try {
    if (!sock) {
      throw new Error("Socket no conectado");
    }

    const messages = messageStore[jid] || [];
    const imageMessages = messages
      .filter((msg) => msg.message?.imageMessage)
      .slice(0, maxImages);

    const downloadedImages = [];

    for (const msg of imageMessages) {
      try {
        const buffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          {
            logger: console,
            reuploadRequest: sock.updateMediaMessage,
          }
        );

        if (buffer) {
          const fileName = `img_${msg.key.id}.jpg`;
          const filePath = path.join(__dirname, "downloads", fileName);

          // Crear directorio si no existe
          if (!fs.existsSync(path.join(__dirname, "downloads"))) {
            fs.mkdirSync(path.join(__dirname, "downloads"));
          }

          fs.writeFileSync(filePath, buffer);

          downloadedImages.push({
            messageId: msg.key.id,
            fileName: fileName,
            filePath: filePath,
            caption: msg.message.imageMessage?.caption || "",
            timestamp: msg.messageTimestamp,
          });
        }
      } catch (error) {
        console.error(`Error descargando imagen ${msg.key.id}:`, error);
      }
    }

    return downloadedImages;
  } catch (error) {
    console.error("Error descargando imágenes:", error);
    return [];
  }
};

// Función para obtener información de todos los chats
const getAllChats = () => {
  try {
    // Usar chatStore del historial si está disponible
    if (Object.keys(chatStore).length > 0) {
      return Object.values(chatStore).map((chat) => ({
        id: chat.id,
        name: chat.name || contactStore[chat.id]?.name || chat.id.split("@")[0],
        unreadCount: chat.unreadCount || 0,
        lastMessageTime: chat.conversationTimestamp,
        isGroup: chat.id.includes("@g.us"),
        messageCount: messageStore[chat.id]?.length || 0,
      }));
    }

    // Fallback al store de mensajes
    const chats = Object.keys(messageStore).map((jid) => ({
      id: jid,
      name:
        contactStore[jid]?.name ||
        (jid.includes("@g.us") ? "Grupo" : jid.split("@")[0]),
      messageCount: messageStore[jid].length,
      isGroup: jid.includes("@g.us"),
      lastMessageTime:
        messageStore[jid][messageStore[jid].length - 1]?.messageTimestamp,
    }));

    return chats;
  } catch (error) {
    console.error("Error obteniendo chats:", error);
    return [];
  }
};

// Función para obtener el JID de tu propio número (para chat contigo mismo)
const getMyJid = () => {
  const myNumber = "";
  console.log({ myNumber });
  return myNumber;
};

app.get("/send-message", async (req, res) => {
  const tempMessage = req.query.message;
  const number = req.query.number;

  let numberWA;
  try {
    if (!number) {
      res.status(500).json({
        status: false,
        response: "El numero no existe",
      });
    } else {
      numberWA = "591" + number + "@s.whatsapp.net";

      if (isConnected()) {
        const exist = await sock.onWhatsApp(numberWA);

        if (exist?.jid || (exist && exist[0]?.jid)) {
          sock
            .sendMessage(exist.jid || exist[0].jid, {
              text: tempMessage,
            })
            .then((result) => {
              res.status(200).json({
                status: true,
                response: result,
              });
            })
            .catch((err) => {
              res.status(500).json({
                status: false,
                response: err,
              });
            });
        }
      } else {
        res.status(500).json({
          status: false,
          response: "Aun no estas conectado",
        });
      }
    }
  } catch (err) {
    res.status(500).send(err);
  }
});

// 📄 ENDPOINT PARA VER EL LOG DE MENSAJES POR CHAT
app.get("/messages-log", async (req, res) => {
  try {
    const logsDir = path.join(__dirname, "chat-logs");
    const { jid, type, sender, limit } = req.query;

    // Si se especifica un JID, devolver solo ese chat
    if (jid) {
      const sanitizedJid = jid.replace(/[@.:]/g, "_");
      const logPath = path.join(logsDir, `${sanitizedJid}.json`);

      if (!fs.existsSync(logPath)) {
        return res.status(200).json({
          status: true,
          messages: [],
          count: 0,
          jid: jid,
          message: "No hay mensajes en el log de este chat todavía",
        });
      }

      const logData = await fs.promises.readFile(logPath, "utf8");
      let messages = JSON.parse(logData);

      // Aplicar filtros
      if (type) {
        messages = messages.filter((msg) => msg.type === type);
      }

      if (limit) {
        messages = messages.slice(-parseInt(limit));
      }

      return res.status(200).json({
        status: true,
        messages: messages.reverse(), // Más recientes primero
        count: messages.length,
        jid: jid,
        chatName: messages[0]?.senderName || jid.split("@")[0],
      });
    }

    // Si no se especifica JID, devolver resumen de todos los chats
    if (!fs.existsSync(logsDir)) {
      return res.status(200).json({
        status: true,
        chats: [],
        totalChats: 0,
        message: "No hay logs de chats todavía",
      });
    }

    const logFiles = fs
      .readdirSync(logsDir)
      .filter((file) => file.endsWith(".json"));
    let allChats = [];

    for (const file of logFiles) {
      try {
        const logPath = path.join(logsDir, file);
        const logData = await fs.promises.readFile(logPath, "utf8");
        const messages = JSON.parse(logData);

        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          const firstMessage = messages[0];

          // Aplicar filtro de sender si se especifica
          let filteredMessages = messages;
          if (sender) {
            filteredMessages = messages.filter(
              (msg) =>
                msg.senderName.toLowerCase().includes(sender.toLowerCase()) ||
                msg.sender.includes(sender)
            );
          }

          if (filteredMessages.length > 0) {
            allChats.push({
              jid: firstMessage.sender,
              chatName: firstMessage.senderName,
              fileName: file,
              totalMessages: messages.length,
              filteredMessages: filteredMessages.length,
              lastMessage: {
                content: lastMessage.content,
                type: lastMessage.type,
                date: lastMessage.date,
              },
              stats: {
                texto: messages.filter((m) => m.type === "texto").length,
                imagen: messages.filter((m) => m.type === "imagen").length,
                hibrido: messages.filter((m) => m.type === "hibrido").length,
                video: messages.filter((m) => m.type === "video").length,
                otro: messages.filter((m) => m.type === "otro").length,
              },
            });
          }
        }
      } catch (error) {
        console.error(`Error procesando archivo ${file}:`, error.message);
      }
    }

    // Ordenar chats por último mensaje (más reciente primero)
    allChats.sort(
      (a, b) => new Date(b.lastMessage.date) - new Date(a.lastMessage.date)
    );

    // Aplicar límite si se especifica
    if (limit) {
      allChats = allChats.slice(0, parseInt(limit));
    }

    res.status(200).json({
      status: true,
      chats: allChats,
      totalChats: logFiles.length,
      filters: { type, sender, limit },
      message: `Para ver mensajes de un chat específico, usa: ?jid=NUMERO@s.whatsapp.net`,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 🧹 ENDPOINT PARA LIMPIAR LOG DE MENSAJES
app.delete("/messages-log", async (req, res) => {
  try {
    const logPath = path.join(__dirname, "messages_log.json");

    if (fs.existsSync(logPath)) {
      await fs.promises.unlink(logPath);
    }

    res.status(200).json({
      status: true,
      response: "Log de mensajes eliminado correctamente",
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 📊 ENDPOINT PARA ESTADÍSTICAS DE MENSAJES POR CHAT
app.get("/messages-stats", async (req, res) => {
  try {
    const logsDir = path.join(__dirname, "chat-logs");

    if (!fs.existsSync(logsDir)) {
      return res.status(200).json({
        status: true,
        stats: {
          totalChats: 0,
          totalMessages: 0,
          messageTypes: {},
          topChats: [],
        },
        message: "No hay logs de chats todavía",
      });
    }

    const logFiles = fs
      .readdirSync(logsDir)
      .filter((file) => file.endsWith(".json"));
    let totalMessages = 0;
    let messageTypes = { texto: 0, imagen: 0, hibrido: 0, video: 0, otro: 0 };
    let chatStats = [];

    for (const file of logFiles) {
      try {
        const logPath = path.join(logsDir, file);
        const logData = await fs.promises.readFile(logPath, "utf8");
        const messages = JSON.parse(logData);

        if (messages.length > 0) {
          totalMessages += messages.length;

          // Contar tipos de mensajes para este chat
          const chatTypes = {
            texto: 0,
            imagen: 0,
            hibrido: 0,
            video: 0,
            otro: 0,
          };
          messages.forEach((msg) => {
            if (messageTypes.hasOwnProperty(msg.type)) {
              messageTypes[msg.type]++;
              chatTypes[msg.type]++;
            } else {
              messageTypes.otro++;
              chatTypes.otro++;
            }
          });

          const lastMessage = messages[messages.length - 1];
          const firstMessage = messages[0];

          chatStats.push({
            jid: firstMessage.sender,
            chatName: firstMessage.senderName,
            fileName: file,
            totalMessages: messages.length,
            messageTypes: chatTypes,
            lastActivity: lastMessage.date,
            firstMessage: firstMessage.date,
          });
        }
      } catch (error) {
        console.error(
          `Error procesando estadísticas del archivo ${file}:`,
          error.message
        );
      }
    }

    // Ordenar chats por número de mensajes (más activos primero)
    chatStats.sort((a, b) => b.totalMessages - a.totalMessages);

    // Top 10 chats más activos
    const topChats = chatStats.slice(0, 10);

    // Estadísticas globales
    const stats = {
      totalChats: logFiles.length,
      totalMessages: totalMessages,
      promedioPorChat: Math.round(totalMessages / logFiles.length) || 0,
      messageTypes: messageTypes,
      topChats: topChats.map((chat) => ({
        chatName: chat.chatName,
        jid: chat.jid,
        totalMessages: chat.totalMessages,
        messageTypes: chat.messageTypes,
        lastActivity: chat.lastActivity,
      })),
      ultimaActividad:
        chatStats.length > 0
          ? chatStats.sort(
              (a, b) => new Date(b.lastActivity) - new Date(a.lastActivity)
            )[0].lastActivity
          : null,
    };

    res.status(200).json({
      status: true,
      stats: stats,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// Endpoint para obtener todos los chats
app.get("/get-chats", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp",
      });
    }

    const chats = getAllChats();
    res.status(200).json({
      status: true,
      chats: chats,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// Endpoint para obtener el historial de un chat específico
app.get("/get-chat-history", async (req, res) => {
  try {
    const { jid, limit } = req.query;

    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp",
      });
    }

    if (!jid) {
      return res.status(400).json({
        status: false,
        response: "Se requiere el parámetro 'jid' del chat",
      });
    }

    const messages = await getChatHistory(jid, parseInt(limit) || 50);

    res.status(200).json({
      status: true,
      jid: jid,
      messages: messages,
      count: messages.length,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});


// 🔧 ENDPOINTS BÁSICOS PARA ESTADO Y LIMPIEZA
app.get("/session-health", async (req, res) => {
  try {
    const health = {
      isConnected: isConnected(),
      socketExists: !!sock,
      userInfo: sock?.user || null,
      sessionPath: path.join(__dirname, "session_auth_info"),
      sessionExists: fs.existsSync(path.join(__dirname, "session_auth_info")),
      memoryStats: {
        messageChats: Object.keys(messageStore).length,
        totalMessages: Object.values(messageStore).reduce(
          (acc, msgs) => acc + msgs.length,
          0
        ),
      },
      macErrors: {
        count: macErrorCount,
        lastReset: new Date(lastMacErrorReset).toISOString(),
        timeSinceReset: Math.floor((Date.now() - lastMacErrorReset) / 1000),
        status: macErrorCount > 50 ? "⚠️ Alto" : macErrorCount > 20 ? "🟡 Medio" : "✅ Normal"
      },
      services: {
        openAI: !!process.env.OPENAI_API_KEY ? "✅ Configurado" : "❌ No configurado",
        googleVision: {
          status: !!visionClient ? "✅ Configurado" : "❌ No configurado",
          credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || "No configurado",
          credentialsExist: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 
            fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS) : false
        }
      }
    };

    res.status(200).json({
      status: true,
      health: health,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 🔄 ENDPOINT PARA VER ESTADOS ACTIVOS DE USUARIOS
app.get("/user-states", async (req, res) => {
  try {
    const activeStates = Array.from(stateMap.entries()).map(([jid, stateData]) => ({
      jid,
      state: stateData.state,
      timestamp: new Date(stateData.timestamp).toISOString(),
      timeElapsed: Math.floor((Date.now() - stateData.timestamp) / 1000),
      hasTimeout: !!stateData.timeout,
      data: {
        hasStructuredData: !!stateData.data.structuredData,
        hasDestinatarioMatch: !!stateData.data.destinatarioMatch,
        newDestinatarioName: stateData.data.newDestinatarioName || null,
        selectedCategoriaId: stateData.data.selectedCategoriaId || null
      }
    }));

    res.status(200).json({
      status: true,
      activeUsers: activeStates.length,
      states: activeStates,
      stateTypes: STATES
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 🔧 ENDPOINT PARA PROBAR SUPABASE Y CATEGORÍAS
app.get("/test-supabase", async (req, res) => {
  try {
    console.log("🧪 Probando conexión a Supabase...");
    
    // Probar conexión básica
    const { data: healthCheck, error: healthError } = await supabase
      .from('categorias')
      .select('count', { count: 'exact', head: true });
    
    if (healthError) {
      return res.status(500).json({
        status: false,
        error: "Error de conexión a Supabase",
        details: healthError.message
      });
    }

    // Obtener categorías
    const categorias = await getCategorias();
    
    // Obtener subcategorías de la primera categoría si existe
    let subcategorias = [];
    if (categorias.length > 0) {
      subcategorias = await getSubcategorias(categorias[0].id);
    }

    res.status(200).json({
      status: true,
      supabase: {
        connected: true,
        url: process.env.SUPABASE_URL ? "✅ Configurado" : "❌ No configurado",
        key: process.env.SUPABASE_SERVICE_ROLE_KEY ? "✅ Configurado" : "❌ No configurado"
      },
      categorias: {
        count: categorias.length,
        data: categorias
      },
      subcategorias: {
        count: subcategorias.length,
        data: subcategorias,
        forCategory: categorias[0]?.nombre || "N/A"
      }
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 🧹 ENDPOINT PARA LIMPIAR ESTADO DE UN USUARIO ESPECÍFICO
app.delete("/user-state/:jid", async (req, res) => {
  try {
    const jid = req.params.jid;
    
    if (stateMap.has(jid)) {
      clearUserState(jid);
      res.status(200).json({
        status: true,
        response: `Estado del usuario ${jid} eliminado exitosamente`
      });
    } else {
      res.status(404).json({
        status: false,
        response: `No se encontró estado activo para el usuario ${jid}`
      });
    }
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 🧹 ENDPOINT PARA LIMPIAR TODOS LOS ESTADOS ACTIVOS
app.delete("/user-states", async (req, res) => {
  try {
    const activeUsersCount = stateMap.size;
    
    // Limpiar todos los timeouts y estados
    for (const [jid] of stateMap) {
      clearUserState(jid);
    }
    
    res.status(200).json({
      status: true,
      response: `Se eliminaron ${activeUsersCount} estados activos`,
      clearedStates: activeUsersCount
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 🧹 ENDPOINT PARA LIMPIAR SESIÓN CORRUPTA
app.post("/clear-session", async (req, res) => {
  try {
    console.log("🧹 Solicitud de limpieza de sesión recibida...");

    if (sock) {
      sock.end();
      sock = null;
    }

    await clearCorruptedSession();

    messageStore = {};
    contactStore = {};
    chatStore = {};

    // Reset contador de errores MAC
    macErrorCount = 0;
    lastMacErrorReset = Date.now();

    res.status(200).json({
      status: true,
      response: "Sesión limpiada exitosamente. El bot se reconectará automáticamente.",
      action: "Visita /scan si necesitas generar un nuevo QR",
      macErrorsReset: true
    });

    // Reconectar después de 3 segundos
    setTimeout(() => {
      console.log("🔄 Reconectando después de limpieza...");
      connectToWhatsApp().catch((err) =>
        console.log("Error reconectando:", err.message)
      );
    }, 3000);
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// Endpoint para limpiar descargas automáticas
app.delete("/clear-downloads", async (req, res) => {
  try {
    const downloadsDir = path.join(__dirname, "downloads");

    if (fs.existsSync(downloadsDir)) {
      const files = fs.readdirSync(downloadsDir);
      let deletedCount = 0;

      for (const file of files) {
        if (file !== "download_log.json") {
          fs.unlinkSync(path.join(downloadsDir, file));
          deletedCount++;
        }
      }

      // Limpiar también el log
      const logPath = path.join(downloadsDir, "download_log.json");
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }

      res.status(200).json({
        status: true,
        response: `Se eliminaron ${deletedCount} archivos descargados automáticamente`,
        deletedFiles: deletedCount,
      });
    } else {
      res.status(200).json({
        status: true,
        response: "No hay directorio de descargas para limpiar",
      });
    }
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// 📁 ENDPOINT PARA VER ESTRUCTURA DE DESCARGAS ORGANIZADAS POR USUARIO
app.get("/downloads-structure", async (req, res) => {
  try {
    const downloadsDir = path.join(__dirname, "downloads");
    const { jid } = req.query;

    if (!fs.existsSync(downloadsDir)) {
      return res.status(200).json({
        status: true,
        structure: {},
        totalUsers: 0,
        totalFiles: 0,
        message: "No hay directorio de descargas todavía",
      });
    }

    // Si se especifica un JID, mostrar solo esa carpeta
    if (jid) {
      const sanitizedJid = jid.replace(/[@.:]/g, "_");
      const userDir = path.join(downloadsDir, sanitizedJid);

      if (!fs.existsSync(userDir)) {
        return res.status(200).json({
          status: true,
          user: jid,
          files: [],
          totalFiles: 0,
          message: "Este usuario no tiene archivos descargados",
        });
      }

      const files = fs.readdirSync(userDir);
      const fileDetails = [];

      for (const file of files) {
        const filePath = path.join(userDir, file);
        const stats = fs.statSync(filePath);
        const fileType = getFileType(file);

        fileDetails.push({
          name: file,
          type: fileType,
          size: formatFileSize(stats.size),
          sizeBytes: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
        });
      }

      // Ordenar por fecha de creación (más reciente primero)
      fileDetails.sort((a, b) => new Date(b.created) - new Date(a.created));

      return res.status(200).json({
        status: true,
        user: jid,
        sanitizedJid: sanitizedJid,
        files: fileDetails,
        totalFiles: files.length,
        stats: getFileTypeStats(fileDetails),
      });
    }

    // Mostrar estructura completa
    const userDirs = fs.readdirSync(downloadsDir).filter((item) => {
      return fs.statSync(path.join(downloadsDir, item)).isDirectory();
    });

    const structure = {};
    let totalFiles = 0;

    for (const userDir of userDirs) {
      const userPath = path.join(downloadsDir, userDir);
      const files = fs.readdirSync(userPath);

      const fileDetails = [];
      for (const file of files) {
        const filePath = path.join(userPath, file);
        const stats = fs.statSync(filePath);
        const fileType = getFileType(file);

        fileDetails.push({
          name: file,
          type: fileType,
          size: formatFileSize(stats.size),
          sizeBytes: stats.size,
          created: stats.birthtime,
        });
      }

      // Ordenar por fecha de creación (más reciente primero)
      fileDetails.sort((a, b) => new Date(b.created) - new Date(a.created));

      totalFiles += files.length;
      structure[userDir] = {
        totalFiles: files.length,
        files: fileDetails,
        stats: getFileTypeStats(fileDetails),
        lastActivity: fileDetails[0]?.created || null,
      };
    }

    // Ordenar usuarios por última actividad
    const sortedStructure = Object.fromEntries(
      Object.entries(structure).sort(
        ([, a], [, b]) =>
          new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)
      )
    );

    res.status(200).json({
      status: true,
      structure: sortedStructure,
      totalUsers: userDirs.length,
      totalFiles: totalFiles,
      message:
        "Para ver archivos de un usuario específico, usa: ?jid=NUMERO@s.whatsapp.net",
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message,
    });
  }
});

// Funciones auxiliares para el endpoint de descargas
function getFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();

  if (
    fileName.startsWith("img_") ||
    [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)
  ) {
    return "imagen";
  } else if (
    fileName.startsWith("vid_") ||
    [".mp4", ".webm", ".avi", ".mov"].includes(ext)
  ) {
    return "video";
  } else if (
    fileName.startsWith("aud_") ||
    [".ogg", ".mp3", ".wav", ".m4a"].includes(ext)
  ) {
    return "audio";
  } else if (fileName.startsWith("doc_")) {
    return "documento";
  } else {
    return "otro";
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function getFileTypeStats(files) {
  const stats = { imagen: 0, video: 0, audio: 0, documento: 0, otro: 0 };
  files.forEach((file) => {
    stats[file.type] = (stats[file.type] || 0) + 1;
  });
  return stats;
}




// 🖼️ FUNCIÓN PARA DESCARGAR IMAGEN DE UN MENSAJE
async function downloadImageFromMessage(message, contactName, messageId) {
  try {
    console.log(`📸 Descargando imagen ${messageId}...`);

    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      const timestamp = message.messageTimestamp || Date.now();
      const caption = message.message.imageMessage?.caption || "";
      const mimetype = message.message.imageMessage?.mimetype || "image/jpeg";

      let extension = ".jpg";
      if (mimetype.includes("png")) extension = ".png";
      else if (mimetype.includes("gif")) extension = ".gif";
      else if (mimetype.includes("webp")) extension = ".webp";

      const downloadDir = path.join(__dirname, "thiago-downloads");
      await fs.promises.mkdir(downloadDir, { recursive: true });

      const fileName = `thiago_${timestamp}_${messageId}${extension}`;
      const filePath = path.join(downloadDir, fileName);

      await fs.promises.writeFile(filePath, buffer);

      // Log de descarga
      const downloadLog = {
        fileName: fileName,
        filePath: filePath,
        messageId: messageId,
        caption: caption,
        mimetype: mimetype,
        fileSize: buffer.length,
        downloadTime: new Date().toISOString(),
      };

      const logPath = path.join(downloadDir, "download_log.json");
      let logs = [];

      try {
        const existingLogs = await fs.promises.readFile(logPath, "utf8");
        logs = JSON.parse(existingLogs);
      } catch (error) {
        // Archivo no existe, empezar logs vacíos
      }

      logs.push(downloadLog);
      await fs.promises.writeFile(logPath, JSON.stringify(logs, null, 2));

      console.log(
        `   ✅ ${fileName} descargado (${formatFileSize(buffer.length)})`
      );
      return { success: true, fileName: fileName, fileSize: buffer.length };
    } else {
      console.log(`   ❌ No se pudo descargar imagen ${messageId}`);
      return { success: false, error: "Buffer vacío" };
    }
  } catch (error) {
    console.error(
      `   ❌ Error descargando imagen ${messageId}:`,
      error.message
    );
    return { success: false, error: error.message };
  }
}

// 🎥 FUNCIÓN PARA DESCARGAR VIDEO DE UN MENSAJE
async function downloadVideoFromMessage(message, contactName, messageId) {
  try {
    console.log(`🎬 Descargando video ${messageId}...`);

    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger: console,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (buffer) {
      const timestamp = message.messageTimestamp || Date.now();
      const caption = message.message.videoMessage?.caption || "";
      const mimetype = message.message.videoMessage?.mimetype || "video/mp4";

      let extension = ".mp4";
      if (mimetype.includes("avi")) extension = ".avi";
      else if (mimetype.includes("mov")) extension = ".mov";
      else if (mimetype.includes("webm")) extension = ".webm";

      const downloadDir = path.join(__dirname, "thiago-downloads");
      await fs.promises.mkdir(downloadDir, { recursive: true });

      const fileName = `thiago_video_${timestamp}_${messageId}${extension}`;
      const filePath = path.join(downloadDir, fileName);

      await fs.promises.writeFile(filePath, buffer);

      console.log(
        `   ✅ ${fileName} descargado (${formatFileSize(buffer.length)})`
      );
      return { success: true, fileName: fileName, fileSize: buffer.length };
    } else {
      console.log(`   ❌ No se pudo descargar video ${messageId}`);
      return { success: false, error: "Buffer vacío" };
    }
  } catch (error) {
    console.error(`   ❌ Error descargando video ${messageId}:`, error.message);
    return { success: false, error: error.message };
  }
}

// 🔧 FUNCIÓN HELPER PARA FORMATEAR TAMAÑO DE ARCHIVO
// function formatFileSize(bytes) {
//   if (bytes === 0) return "0 Bytes";
//   const k = 1024;
//   const sizes = ["Bytes", "KB", "MB", "GB"];
//   const i = Math.floor(Math.log(bytes) / Math.log(k));
//   return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
// }

io.on("connection", async (socket) => {
  soket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qrDinamic) {
    updateQR("qr");
  }
});

const updateQR = (data) => {
  switch (data) {
    case "qr":
      qrcode.toDataURL(qrDinamic, (err, url) => {
        soket?.emit("qr", url);
        soket?.emit("log", "QR recibido , scan");
      });
      break;
    case "connected":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", " usaario conectado");
      const { id, name } = sock?.user;
      var userinfo = id + " " + name;
      soket?.emit("user", userinfo);

      break;
    case "loading":
      soket?.emit("qrstatus", "./assets/loader.gif");
      soket?.emit("log", "Cargando ....");

      break;
    default:
      break;
  }
};

// 🚀 FUNCIÓN DE INICIO SIMPLIFICADA Y ROBUSTA
const startApp = async () => {
  try {
    console.log("🚀 Iniciando WhatsApp Bot con OCR y OpenAI...");
    console.log("⚠️ Los errores 'Bad MAC' son normales durante la conexión inicial");
    
    // Verificar variables de entorno (sin detener la ejecución)
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ OPENAI_API_KEY no configurada - IA deshabilitada");
    }
    
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.warn("⚠️ GOOGLE_APPLICATION_CREDENTIALS no configurada - OCR deshabilitado");
    }
    
    console.log("📱 Conectando a WhatsApp...");
    connectToWhatsApp().catch(err => {
      console.log("⚠️ Error en conexión inicial (se reintentará automáticamente):", err.message);
    });
    
    
    console.log(`🌐 Iniciando servidor en puerto ${port}...`);
    server.listen(port, () => {
      console.log(`✅ Servidor activo en puerto: ${port}`);
      console.log(`📱 Panel: http://localhost:${port}/scan`);
      console.log(`🔗 Estado: http://localhost:${port}/session-health`);
      console.log(`📊 Logs: http://localhost:${port}/messages-log`);
      console.log("🤖 Bot iniciado - esperando conexión a WhatsApp");
    });
    
  } catch (error) {
    console.error("❌ Error crítico en inicio:", error.message);
    setTimeout(startApp, 10000);
  }
};

process.on('uncaughtException', (error) => {
  // Filtrar errores MAC que no son críticos
  if (error.message?.includes("Bad MAC") || 
      error.message?.includes("Failed to decrypt") ||
      error.message?.includes("Session error")) {
    // Solo mostrar un resumen cada 30 segundos para evitar spam
    if (!global.lastMacErrorLog || Date.now() - global.lastMacErrorLog > 30000) {
      console.log("⚠️ Errores de descifrado detectados (normal durante sincronización inicial)");
      global.lastMacErrorLog = Date.now();
    }
    return; // No cerrar la aplicación por errores MAC
  }
  
  // Otros errores sí son críticos
  console.error('❌ Error crítico no capturado:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  const errorMessage = reason?.message || reason;

  if (typeof errorMessage === 'string' && 
      (errorMessage.includes("Bad MAC") || 
       errorMessage.includes("Failed to decrypt") ||
       errorMessage.includes("Session error"))) {
    
    return;
  }
  
  console.error('❌ Promesa rechazada no manejada:', errorMessage);
});

startApp();
