const {
  default: makeWASocket,
  MessageType,
  MessageOptions,
  Mimetype,
  DisconnectReason,
  BufferJSON,
  AnyMessageContent,
  delay,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  MessageRetryMap,
  useMultiFileAuthState,
  msgRetryCounterMap,
  downloadMediaMessage,
  getContentType,
  Browsers,
} = require("@whiskeysockets/baileys");

const log = (pino = require("pino"));
const { session } = { session: "session_auth_info" };
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = require("express")();
// enable files upload
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
    if (typeof makeInMemoryStore === 'function') {
      const store = makeInMemoryStore({ logger: log({ level: "debug" }) });
      store.readFromFile('./baileys_store.json');
      
      // Guardar el store cada 10 segundos
      setInterval(() => {
        store.writeToFile('./baileys_store.json');
      }, 10_000);
      
      return store;
    }
  } catch (error) {
    console.log("makeInMemoryStore no disponible, usando store manual");
  }
  return null;
};

const store = initStore();

// Función para limpiar sesiones corruptas
const clearCorruptedSession = async () => {
  try {
    const sessionPath = path.join(__dirname, 'session_auth_info');
    if (fs.existsSync(sessionPath)) {
      console.log("🧹 Limpiando sesión corrupta...");
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("✅ Sesión limpiada. Será necesario escanear el QR nuevamente.");
    }
    
    // También limpiar el store de Baileys si existe
    const storePath = path.join(__dirname, 'baileys_store.json');
    if (fs.existsSync(storePath)) {
      fs.unlinkSync(storePath);
      console.log("✅ Store de Baileys limpiado.");
    }
  } catch (error) {
    console.error("❌ Error limpiando sesión:", error);
  }
};

// Función para manejar errores de descifrado de manera más elegante
const handleDecryptionError = (error, jid) => {
  if (error.message?.includes('Bad MAC')) {
    console.log(`⚠️ Error de MAC para ${jid}, mensaje no se pudo descifrar - continuando...`);
    return true; // Indica que el error fue manejado
  }
  return false; // Error no manejado
};

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("session_auth_info");

  sock = makeWASocket({
    auth: state,
    logger: log({ level: "silent" }),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    browser: Browsers.windows('Desktop'),
    cachedGroupMetadata: true,
    // Configuraciones para manejar mejor los errores de sesión
    retryRequestDelayMs: 60000, // 1 minuto de delay entre reintentos
    maxMsgRetryCount: 3, // máximo 3 reintentos por mensaje
    fireInitQueries: true,
    emitOwnEvents: false,
    markOnlineOnConnect: false,
    // Configurar el manejo de errores de descifrado
    shouldIgnoreJid: (jid) => false,
    // Configurar para ignorar errores de MAC temporalmente
    printQRInTerminal: false,
  });

  // Vincular el store al socket si está disponible
  if (store) {
    store.bind(sock.ev);
  }

  // Manejar errores de descifrado de mensajes y descargar imágenes automáticamente
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const msg of messages) {
        try {
          // Verificar si el mensaje se descifró correctamente
          if (msg.messageStubType || msg.message) {
            const jid = msg.key.remoteJid;
            if (!messageStore[jid]) {
              messageStore[jid] = [];
            }
            
            // Evitar duplicados
            const existingMsg = messageStore[jid].find(m => m.key.id === msg.key.id);
            if (!existingMsg) {
              messageStore[jid].push(msg);
            }
            
            // 🖼️ DESCARGAR IMAGEN AUTOMÁTICAMENTE SI EL MENSAJE CONTIENE UNA
            if (msg.message?.imageMessage) {
              try {
                console.log(`📥 Nueva imagen detectada de ${jid}, descargando...`);
                
                // Descargar la imagen
                const buffer = await downloadMediaMessage(
                  msg,
                  "buffer",
                  {},
                  { 
                    logger: console, 
                    reuploadRequest: sock.updateMediaMessage 
                  }
                );
                
                if (buffer) {
                  // Crear directorio si no existe
                  const downloadsDir = path.join(__dirname, 'downloads');
                  if (!fs.existsSync(downloadsDir)) {
                    fs.mkdirSync(downloadsDir, { recursive: true });
                  }
                  
                  // Obtener información del remitente
                  const senderName = contactStore[jid]?.name || jid.split('@')[0];
                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                  const messageId = msg.key.id;
                  
                  // Determinar extensión según mimetype
                  const mimetype = msg.message.imageMessage.mimetype || 'image/jpeg';
                  let extension = '.jpg';
                  if (mimetype.includes('png')) extension = '.png';
                  else if (mimetype.includes('gif')) extension = '.gif';
                  else if (mimetype.includes('webp')) extension = '.webp';
                  
                  // Crear nombre de archivo único
                  const fileName = `${senderName}_${timestamp}_${messageId}${extension}`;
                  const filePath = path.join(downloadsDir, fileName);
                  
                  // Guardar la imagen
                  await fs.promises.writeFile(filePath, buffer);
                  
                  const caption = msg.message.imageMessage.caption || 'Sin descripción';
                  console.log(`✅ Imagen descargada y descifrada: ${fileName}`);
                  console.log(`📝 Descripción: ${caption}`);
                  console.log(`💾 Guardada en: ${filePath}`);
                  
                  // Opcional: Guardar información adicional en un log
                  const logInfo = {
                    messageId: messageId,
                    sender: jid,
                    senderName: senderName,
                    fileName: fileName,
                    filePath: filePath,
                    caption: caption,
                    mimetype: mimetype,
                    downloadTime: new Date().toISOString(),
                    timestamp: msg.messageTimestamp
                  };
                  
                  // Guardar log de descarga
                  const logPath = path.join(downloadsDir, 'download_log.json');
                  let logs = [];
                  if (fs.existsSync(logPath)) {
                    try {
                      const existingLogs = await fs.promises.readFile(logPath, 'utf8');
                      logs = JSON.parse(existingLogs);
                    } catch (error) {
                      console.log('Error leyendo log existente, creando nuevo');
                    }
                  }
                  logs.push(logInfo);
                  await fs.promises.writeFile(logPath, JSON.stringify(logs, null, 2));
                  
                } else {
                  console.log(`❌ No se pudo descargar la imagen del mensaje ${msg.key.id}`);
                }
                
              } catch (error) {
                console.error(`❌ Error descargando imagen automáticamente:`, error.message);
              }
            }
            
            // 🎥 OPCIONAL: También descargar videos automáticamente
            if (msg.message?.videoMessage) {
              try {
                console.log(`📹 Nuevo video detectado de ${jid}, descargando...`);
                
                const buffer = await downloadMediaMessage(
                  msg,
                  "buffer",
                  {},
                  { 
                    logger: console, 
                    reuploadRequest: sock.updateMediaMessage 
                  }
                );
                
                if (buffer) {
                  const downloadsDir = path.join(__dirname, 'downloads');
                  if (!fs.existsSync(downloadsDir)) {
                    fs.mkdirSync(downloadsDir, { recursive: true });
                  }
                  
                  const senderName = contactStore[jid]?.name || jid.split('@')[0];
                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                  const messageId = msg.key.id;
                  
                  const mimetype = msg.message.videoMessage.mimetype || 'video/mp4';
                  let extension = '.mp4';
                  if (mimetype.includes('avi')) extension = '.avi';
                  else if (mimetype.includes('mov')) extension = '.mov';
                  else if (mimetype.includes('webm')) extension = '.webm';
                  
                  const fileName = `video_${senderName}_${timestamp}_${messageId}${extension}`;
                  const filePath = path.join(downloadsDir, fileName);
                  
                  await fs.promises.writeFile(filePath, buffer);
                  
                  const caption = msg.message.videoMessage.caption || 'Sin descripción';
                  console.log(`✅ Video descargado: ${fileName}`);
                  console.log(`📝 Descripción: ${caption}`);
                }
              } catch (error) {
                console.error(`❌ Error descargando video automáticamente:`, error.message);
              }
            }
          }
        } catch (error) {
          console.error(`❌ Error procesando mensaje:`, error.message);
        }
      }
    }
  });

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
        console.log(`Motivo de desconexión desconocido: ${reason}|${lastDisconnect.error}`);
        // Si hay errores repetidos de MAC, limpiar la sesión
        if (lastDisconnect.error?.message?.includes('Bad MAC')) {
          console.log("Error de MAC detectado, limpiando sesión...");
          await clearCorruptedSession();
        }
        sock.end();
      }
    } else if (connection === "open") {
      console.log("conexión abierta");

      app.get("/force-sync/:jid/:max?", async (req, res) => {
        const jid         = req.params.jid;
        const maxMessages = parseInt(req.params.max) || 1000;

        // 1) Chequeo de conexión
        if (!sock.user || typeof sock.fetchMessageHistory !== "function") {
          return res
            .status(500)
            .json({ status: false, error: "Socket no conectado o método no disponible" });
        }

        console.log(`🚀 Forzando sync de ${jid} hasta ${maxMessages} mensajes…`);
        res.json({ status: true, message: "Sincronización en background" });

        // 2) Bucle de fetch on‑demand
        let cursorKey       ={
        "remoteJid": "51950306310@s.whatsapp.net",
        "fromMe": true,
        "id": "3EB01527A7B79981B4ADD6"
      }
        let cursorTimestamp = 1753543479
        let total           = 0;
        messageStore[jid]   = [];

        while (total < maxMessages) {
          console.log(`📦 fetchMessageHistory(count=${50}, key=${cursorKey?.id||"null"}, ts=${cursorTimestamp||"null"})`);
          let raw;
          try {
            raw = await sock.fetchMessageHistory(
              50,
              cursorKey,
              cursorTimestamp
            );
          } catch (e) {
            console.error("❌ fetchMessageHistory fallo:", e);
            break;
          }

          // Según doc, fetchMessageHistory devuelve un JSON-string:
          const data = JSON.parse(raw);
          const msgs = data.messages || [];
          if (!msgs.length) {
            console.log("📭 No quedan mensajes.");
            break;
          }

          // Almacena sin duplicados
          const storeArr = messageStore[jid];
          msgs.forEach(m => {
            if (!storeArr.find(x => x.key.id === m.key.id)) {
              storeArr.push(m);
            }
          });

          // Avanza cursor
          const last = msgs[msgs.length - 1];
          cursorKey       = last.key;
          cursorTimestamp = last.messageTimestamp;
          total          += msgs.length;

          console.log(`✅ Paquete de ${msgs.length} cargado (total ${total})`);
          await new Promise(r => setTimeout(r, 500));
        }

        console.log(`🎉 Sincronización completada: ${total} mensajes.`);
        fs.writeFileSync(
          path.join(__dirname, `history-${jid.replace(/[@.]/g, "_")}.json`),
          JSON.stringify(messageStore[jid], null, 2),
          "utf8"
        );
        console.log("💾 Archivo escrito.");
      });
       
    }
  });

  // sock.ev.on("messages.upsert", async ({ messages, type }) => {
  //   try {
  //     if (type === "notify") {
  //       // Guardar mensajes en nuestro store temporal
  //       messages.forEach(message => {
  //         const jid = message.key.remoteJid;
  //         if (!messageStore[jid]) {
  //           messageStore[jid] = [];
  //         }
  //         messageStore[jid].push(message);
          
  //         // Mantener solo los últimos 100 mensajes por chat
  //         if (messageStore[jid].length > 100) {
  //           messageStore[jid] = messageStore[jid].slice(-100);
  //         }
  //       });

  //       if (!messages[0]?.key.fromMe) {
  //         const captureMessage = messages[0]?.message?.conversation;
  //         const numberWa = messages[0]?.key?.remoteJid;

  //         const compareMessage = captureMessage.toLocaleLowerCase();

  //         if (compareMessage === "ping") {
  //           await sock.sendMessage(
  //             numberWa,
  //             {
  //               text: "Pong",
  //             },
  //             {
  //               quoted: messages[0],
  //             }
  //           );
  //         } else {
  //           await sock.sendMessage(
  //             numberWa,
  //             {
  //               text: "Soy un robot",
  //             },
  //             {
  //               quoted: messages[0],
  //             }
  //           );
  //         }
  //       }
  //     }
  //   } catch (error) {
  //     console.log("error ", error);
  //   }
  // });

  sock.ev.on("creds.update", saveCreds);

  // Listener para sincronización de historial - ESTE ES EL IMPORTANTE
  // sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
  //   console.log(`📥 HISTORIAL RECIBIDO: ${messages.length} mensajes, ${chats.length} chats, ${contacts.length} contactos. Es el último: ${isLatest}`);
    
  //   try {
  //     // Guardar chats en nuestro store
  //     chats.forEach(chat => {
  //       try {
  //         chatStore[chat.id] = chat;
  //       } catch (error) {
  //         console.log(`⚠️ Error procesando chat ${chat.id}:`, error.message);
  //       }
  //     });
      
  //     // Guardar contactos
  //     contacts.forEach(contact => {
  //       try {
  //         contactStore[contact.id] = contact;
  //       } catch (error) {
  //         console.log(`⚠️ Error procesando contacto ${contact.id}:`, error.message);
  //       }
  //     });
      
  //     // Guardar mensajes del historial con manejo de errores
  //     let processedMessages = 0;
  //     let skippedMessages = 0;
      
  //     messages.forEach(msg => {
  //       try {
  //         // Verificar que el mensaje tenga la estructura mínima requerida
  //         if (!msg.key || !msg.key.remoteJid) {
  //           skippedMessages++;
  //           return;
  //         }
          
  //         const jid = msg.key.remoteJid;
  //         if (!messageStore[jid]) {
  //           messageStore[jid] = [];
  //         }
          
  //         // Evitar duplicados
  //         const existingMsg = messageStore[jid].find(m => m.key.id === msg.key.id);
  //         if (!existingMsg) {
  //           messageStore[jid].push(msg);
  //           processedMessages++;
  //         }
  //       } catch (error) {
  //         skippedMessages++;
  //         if (!handleDecryptionError(error, msg.key?.remoteJid)) {
  //           console.log(`⚠️ Error procesando mensaje:`, error.message);
  //         }
  //       }
  //     });
      
  //     console.log(`✅ Procesados: ${processedMessages} mensajes, Omitidos: ${skippedMessages}`);
      
  //     // Ordenar mensajes por timestamp
  //     Object.keys(messageStore).forEach(jid => {
  //       try {
  //         messageStore[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
  //       } catch (error) {
  //         console.log(`⚠️ Error ordenando mensajes para ${jid}:`, error.message);
  //       }
  //     });
      
  //     if (isLatest) {
  //       console.log("✅ Sincronización de historial completada");
  //       console.log(`📊 Chats totales: ${Object.keys(chatStore).length}`);
  //       console.log(`👥 Contactos totales: ${Object.keys(contactStore).length}`);
  //       console.log(`💬 Mensajes totales: ${Object.values(messageStore).reduce((acc, msgs) => acc + msgs.length, 0)}`);
  //     }
  //   } catch (error) {
  //     console.error("❌ Error en sincronización de historial:", error.message);
  //   }
  // });

//   sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType }) => {
//   console.log('📥 messaging-history.set recibida — tipo:', syncType);
//   console.log(`Chats: ${chats.length}, Contacts: ${contacts.length}, Messages: ${messages.length}`);

//   const logData = { syncType, chats, contacts, messages };
//   await fs.writeFile('history-sync.log.json', JSON.stringify(logData, null, 2));
//   console.log('Historial guardado en history-sync.log.json');
// });
sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType }) => {
  console.log('syncType:', syncType);
  console.log(`Chats ${chats.length}, msgs ${messages.length}`);
  await fs.writeFile('history.json', JSON.stringify({ chats, contacts, messages }, null, 2));
  for (const m of messages) {
    console.log(`msg ${m.key.id} from ${m.key.remoteJid}`, m.message?.imageMessage ? '📷' : '');
    if (m.message?.imageMessage) {
      const buf = await downloadMediaMessage(m, 'buffer');
      await fs.writeFile(`img-${m.key.id}.jpg`, buf);
    }
  }
});
}

const isConnected = () => {
  return sock?.user ? true : false;
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
    const processedMessages = limitedMessages.map(msg => {
      const processed = { ...msg };
      
      // Agregar información del tipo de mensaje
      if (msg.message) {
        const messageType = getContentType(msg.message);
        processed.messageType = messageType;
        
        // Si es una imagen, agregar información de descarga
        if (messageType === 'imageMessage') {
          processed.mediaInfo = {
            type: 'image',
            mimetype: msg.message.imageMessage?.mimetype,
            url: msg.message.imageMessage?.url,
            caption: msg.message.imageMessage?.caption,
            hasMedia: true
          };
        }
        
        // Si es un video
        if (messageType === 'videoMessage') {
          processed.mediaInfo = {
            type: 'video',
            mimetype: msg.message.videoMessage?.mimetype,
            url: msg.message.videoMessage?.url,
            caption: msg.message.videoMessage?.caption,
            hasMedia: true
          };
        }
        
        // Si es un documento
        if (messageType === 'documentMessage') {
          processed.mediaInfo = {
            type: 'document',
            mimetype: msg.message.documentMessage?.mimetype,
            fileName: msg.message.documentMessage?.fileName,
            hasMedia: true
          };
        }
        
        // Si es audio
        if (messageType === 'audioMessage') {
          processed.mediaInfo = {
            type: 'audio',
            mimetype: msg.message.audioMessage?.mimetype,
            hasMedia: true
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
      
      messages.forEach(msg => {
        const existingMsg = messageStore[jid].find(m => m.key.id === msg.key.id);
        if (!existingMsg) {
          messageStore[jid].unshift(msg); // Agregar al inicio (son más antiguos)
        }
      });
      
      // Reordenar por timestamp
      messageStore[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
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
    const imageMessages = messages.filter(msg => 
      msg.message?.imageMessage
    ).slice(0, maxImages);

    const downloadedImages = [];
    
    for (const msg of imageMessages) {
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { 
            logger: console, 
            reuploadRequest: sock.updateMediaMessage 
          }
        );
        
        if (buffer) {
          const fileName = `img_${msg.key.id}.jpg`;
          const filePath = path.join(__dirname, 'downloads', fileName);
          
          // Crear directorio si no existe
          if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
            fs.mkdirSync(path.join(__dirname, 'downloads'));
          }
          
          fs.writeFileSync(filePath, buffer);
          
          downloadedImages.push({
            messageId: msg.key.id,
            fileName: fileName,
            filePath: filePath,
            caption: msg.message.imageMessage?.caption || '',
            timestamp: msg.messageTimestamp
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
      return Object.values(chatStore).map(chat => ({
        id: chat.id,
        name: chat.name || (contactStore[chat.id]?.name) || chat.id.split('@')[0],
        unreadCount: chat.unreadCount || 0,
        lastMessageTime: chat.conversationTimestamp,
        isGroup: chat.id.includes('@g.us'),
        messageCount: messageStore[chat.id]?.length || 0
      }));
    }
    
    // Fallback al store de mensajes
    const chats = Object.keys(messageStore).map(jid => ({
      id: jid,
      name: contactStore[jid]?.name || (jid.includes('@g.us') ? 'Grupo' : jid.split('@')[0]),
      messageCount: messageStore[jid].length,
      isGroup: jid.includes('@g.us'),
      lastMessageTime: messageStore[jid][messageStore[jid].length - 1]?.messageTimestamp
    }));
    
    return chats;
  } catch (error) {
    console.error("Error obteniendo chats:", error);
    return [];
  }
};

async function loadMore(jid, n = 50) {
  const resp = await sock.fetchMessageHistory(jid, { count: n });
  for (const msg of resp.messages) db.saveMessage(msg);
  return resp.messages;
}

// Función para obtener el JID de tu propio número (para chat contigo mismo)
const getMyJid = () => {
  const myNumber = "120363409784607407@g.us";
  console.log({myNumber});
  return myNumber;
};

// 🔄 FUNCIÓN PARA SINCRONIZAR TODO EL HISTORIAL DE UN CHAT ESPECÍFICO
const syncFullChatHistory = async (jid, maxMessages = 1000) => {
  try {
    if (!sock || !sock.loadMessages) {
      throw new Error("Socket no conectado o loadMessages no disponible");
    }

    console.log(`🔄 Iniciando sincronización completa del chat: ${jid}`);
    
    let allMessages = [];
    let cursor = null;
    let totalLoaded = 0;
    let batchCount = 0;
    const batchSize = 50; // Cargar 50 mensajes por vez
    
    // Limpiar mensajes existentes de este chat para evitar duplicados
    messageStore[jid] = [];
    
    do {
      try {
        console.log(`📦 Cargando lote ${++batchCount} (cursor: ${cursor?.id || 'inicio'})`);
        
        // Cargar mensajes con paginación
        const messages = await sock.loadMessages(jid, batchSize, cursor);
        
        if (!messages || messages.length === 0) {
          console.log("📭 No hay más mensajes para cargar");
          break;
        }
        
        // Agregar mensajes al array total
        allMessages = allMessages.concat(messages);
        totalLoaded += messages.length;
        
        // Agregar mensajes al store
        messages.forEach(msg => {
          const existingMsg = messageStore[jid].find(m => m.key.id === msg.key.id);
          if (!existingMsg) {
            messageStore[jid].push(msg);
          }
        });
        
        // Actualizar cursor para siguiente lote
        cursor = messages[messages.length - 1].key;
        
        console.log(`✅ Lote ${batchCount} cargado: ${messages.length} mensajes (Total: ${totalLoaded})`);
        
        // Pausa pequeña para no sobrecargar
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Límite de seguridad
        if (totalLoaded >= maxMessages) {
          console.log(`⚠️ Alcanzado límite máximo de ${maxMessages} mensajes`);
          break;
        }
        
      } catch (error) {
        console.error(`❌ Error cargando lote ${batchCount}:`, error.message);
        break;
      }
      
    } while (true);
    
    // Ordenar todos los mensajes por timestamp
    messageStore[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
    
    console.log(`🎉 Sincronización completa terminada para ${jid}`);
    console.log(`📊 Total de mensajes cargados: ${totalLoaded}`);
    console.log(`📦 Total de lotes procesados: ${batchCount}`);
    
    // Estadísticas adicionales
    const imageCount = messageStore[jid].filter(msg => msg.message?.imageMessage).length;
    const videoCount = messageStore[jid].filter(msg => msg.message?.videoMessage).length;
    const textCount = messageStore[jid].filter(msg => msg.message?.conversation || msg.message?.extendedTextMessage).length;
    
    const stats = {
      totalMessages: totalLoaded,
      batches: batchCount,
      images: imageCount,
      videos: videoCount,
      textMessages: textCount,
      timeRange: {
        oldest: messageStore[jid][0]?.messageTimestamp,
        newest: messageStore[jid][messageStore[jid].length - 1]?.messageTimestamp
      }
    };
    
    console.log(`📈 Estadísticas: ${stats.textMessages} textos, ${stats.images} imágenes, ${stats.videos} videos`);
    
    return {
      success: true,
      jid: jid,
      stats: stats,
      messages: allMessages
    };
    
  } catch (error) {
    console.error(`❌ Error en sincronización completa:`, error);
    return {
      success: false,
      error: error.message,
      jid: jid
    };
  }
};

// 🔄 FUNCIÓN PARA SINCRONIZAR MÚLTIPLES CHATS
const syncMultipleChats = async (jids, maxMessagesPerChat = 500) => {
  const results = [];
  
  for (const jid of jids) {
    console.log(`🔄 Sincronizando chat ${jid}...`);
    const result = await syncFullChatHistory(jid, maxMessagesPerChat);
    results.push(result);
    
    // Pausa entre chats para no sobrecargar
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return results;
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

// Endpoint para obtener todos los chats
app.get("/get-chats", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    const chats = getAllChats();
    res.status(200).json({
      status: true,
      chats: chats
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
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
        response: "No estás conectado a WhatsApp"
      });
    }

    if (!jid) {
      return res.status(400).json({
        status: false,
        response: "Se requiere el parámetro 'jid' del chat"
      });
    }

    const messages = await getChatHistory(jid, parseInt(limit) || 50);
    
    res.status(200).json({
      status: true,
      jid: jid,
      messages: messages,
      count: messages.length
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para obtener tu propio historial (chat contigo mismo)
app.get("/get-my-history", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    const myJid = getMyJid();
    if (!myJid) {
      return res.status(500).json({
        status: false,
        response: "No se pudo obtener tu JID"
      });
    }

    const limit = parseInt(req.query.limit) || 20;
    const messages = await getChatHistory(myJid, limit);
    
    res.status(200).json({
      status: true,
      myJid: myJid,
      messages: messages,
      count: messages.length
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para forzar sincronización de historial
app.get("/sync-history", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    res.status(200).json({
      status: true,
      response: "La sincronización ocurre automáticamente al conectar. Revisa los logs de la consola.",
      totalChats: Object.keys(chatStore).length,
      totalMessages: Object.values(messageStore).reduce((acc, msgs) => acc + msgs.length, 0)
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para cargar más mensajes con paginación
app.get("/load-messages", async (req, res) => {
  try {
    const { jid, count, cursor } = req.query;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    if (!jid) {
      return res.status(400).json({
        status: false,
        response: "Se requiere el parámetro 'jid' del chat"
      });
    }

    const cursorObj = cursor ? { id: cursor } : null;
    const messages = await loadMessagesWithPagination(jid, parseInt(count) || 25, cursorObj);
    
    const nextCursor = messages && messages.length > 0 ? messages[messages.length - 1].key.id : null;
    
    res.status(200).json({
      status: true,
      jid: jid,
      messages: messages,
      count: messages.length,
      nextCursor: nextCursor,
      totalInStore: messageStore[jid]?.length || 0
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para descargar media de un mensaje específico
app.get("/download-media", async (req, res) => {
  try {
    const { jid, messageId } = req.query;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    if (!jid || !messageId) {
      return res.status(400).json({
        status: false,
        response: "Se requieren los parámetros 'jid' y 'messageId'"
      });
    }

    // Buscar el mensaje
    const messages = messageStore[jid] || [];
    const message = messages.find(msg => msg.key.id === messageId);
    
    if (!message) {
      return res.status(404).json({
        status: false,
        response: "Mensaje no encontrado"
      });
    }

    const messageType = getContentType(message.message);
    
    if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
      return res.status(400).json({
        status: false,
        response: "El mensaje no contiene media"
      });
    }

    // Descargar el media
    const buffer = await downloadMediaMessage(
      message, 
      'buffer', 
      {}, 
      { 
        logger: console, 
        reuploadRequest: sock.updateMediaMessage 
      }
    );
    
    if (!buffer) {
      return res.status(500).json({
        status: false,
        response: "Error descargando media"
      });
    }

    const mediaMessage = message.message[messageType];
    const mimetype = mediaMessage.mimetype || 'application/octet-stream';
    
    // Obtener extensión según el tipo
    let extension = '';
    if (mimetype.includes('jpeg') || mimetype.includes('jpg')) extension = '.jpg';
    else if (mimetype.includes('png')) extension = '.png';
    else if (mimetype.includes('gif')) extension = '.gif';
    else if (mimetype.includes('mp4')) extension = '.mp4';
    else if (mimetype.includes('mp3')) extension = '.mp3';
    else if (mimetype.includes('pdf')) extension = '.pdf';
    else if (mediaMessage.fileName) {
      const fileName = mediaMessage.fileName;
      extension = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
    }
    
    const fileName = `media_${messageId}${extension}`;
    
    res.set({
      'Content-Type': mimetype,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length
    });
    
    res.send(buffer);
    
  } catch (error) {
    console.error("Error descargando media:", error);
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para descargar todas las imágenes de un chat
app.get("/download-all-images", async (req, res) => {
  try {
    const { jid, maxImages } = req.query;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    if (!jid) {
      return res.status(400).json({
        status: false,
        response: "Se requiere el parámetro 'jid' del chat"
      });
    }

    const maxImagess = maxImages || 50;

    const downloadedImages = await downloadAllImagesFromChat(jid, parseInt(maxImagess) || 50);
    
    res.status(200).json({
      status: true,
      jid: jid,
      downloadedImages: downloadedImages,
      count: downloadedImages.length,
      downloadPath: path.join(__dirname, 'downloads')
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para obtener estadísticas del historial
app.get("/history-stats", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    const stats = {
      totalChats: Object.keys(chatStore).length || Object.keys(messageStore).length,
      totalContacts: Object.keys(contactStore).length,
      totalMessages: Object.values(messageStore).reduce((acc, msgs) => acc + msgs.length, 0),
      chatsWithMessages: Object.keys(messageStore).length,
      myJid: getMyJid(),
      storeType: store ? 'Baileys Store' : 'Manual Store'
    };
    
    res.status(200).json({
      status: true,
      stats: stats
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para limpiar sesión corrupta
app.post("/clear-session", async (req, res) => {
  try {
    console.log("🧹 Solicitud de limpieza de sesión recibida...");
    
    // Cerrar conexión actual si existe
    if (sock) {
      sock.end();
      sock = null;
    }
    
    // Limpiar sesión
    await clearCorruptedSession();
    
    // Limpiar stores en memoria
    messageStore = {};
    contactStore = {};
    chatStore = {};
    
    res.status(200).json({
      status: true,
      response: "Sesión limpiada exitosamente. Será necesario escanear el QR nuevamente.",
      action: "Visita /scan para generar un nuevo QR"
    });
    
    // Intentar reconectar después de un breve delay
    setTimeout(() => {
      console.log("🔄 Intentando reconectar...");
      connectToWhatsApp().catch(err => console.log("Error reconectando:", err));
    }, 2000);
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para obtener información de errores
app.get("/session-health", async (req, res) => {
  try {
    const health = {
      isConnected: isConnected(),
      socketExists: !!sock,
      userInfo: sock?.user || null,
      sessionPath: path.join(__dirname, 'session_auth_info'),
      sessionExists: fs.existsSync(path.join(__dirname, 'session_auth_info')),
      storeFile: path.join(__dirname, 'baileys_store.json'),
      storeExists: fs.existsSync(path.join(__dirname, 'baileys_store.json')),
      memoryStats: {
        chats: Object.keys(chatStore).length,
        contacts: Object.keys(contactStore).length,
        messageChats: Object.keys(messageStore).length,
        totalMessages: Object.values(messageStore).reduce((acc, msgs) => acc + msgs.length, 0)
      }
    };
    
    res.status(200).json({
      status: true,
      health: health
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para ver las descargas automáticas
app.get("/auto-downloads", async (req, res) => {
  try {
    const downloadsDir = path.join(__dirname, 'downloads');
    const logPath = path.join(downloadsDir, 'download_log.json');
    
    let downloads = [];
    if (fs.existsSync(logPath)) {
      try {
        const logData = await fs.promises.readFile(logPath, 'utf8');
        downloads = JSON.parse(logData);
      } catch (error) {
        console.error('Error leyendo log de descargas:', error);
      }
    }
    
    // Obtener lista de archivos en el directorio de descargas
    let files = [];
    if (fs.existsSync(downloadsDir)) {
      files = fs.readdirSync(downloadsDir).filter(file => file !== 'download_log.json');
    }
    
    res.status(200).json({
      status: true,
      totalDownloads: downloads.length,
      totalFiles: files.length,
      downloads: downloads.slice(-20), // Últimas 20 descargas
      files: files.slice(-20), // Últimos 20 archivos
      downloadPath: downloadsDir
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// Endpoint para limpiar descargas automáticas
app.delete("/clear-downloads", async (req, res) => {
  try {
    const downloadsDir = path.join(__dirname, 'downloads');
    
    if (fs.existsSync(downloadsDir)) {
      const files = fs.readdirSync(downloadsDir);
      let deletedCount = 0;
      
      for (const file of files) {
        if (file !== 'download_log.json') {
          fs.unlinkSync(path.join(downloadsDir, file));
          deletedCount++;
        }
      }
      
      // Limpiar también el log
      const logPath = path.join(downloadsDir, 'download_log.json');
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      
      res.status(200).json({
        status: true,
        response: `Se eliminaron ${deletedCount} archivos descargados automáticamente`,
        deletedFiles: deletedCount
      });
    } else {
      res.status(200).json({
        status: true,
        response: "No hay directorio de descargas para limpiar"
      });
    }
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// 🔄 ENDPOINT PARA SINCRONIZAR HISTORIAL COMPLETO DE UN CHAT ESPECÍFICO
app.get("/sync-chat-full/:jid/:maxMessages?", async (req, res) => {

  try {
    const { jid, maxMessages } = req.params;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    if (!jid) {
      return res.status(400).json({
        status: false,
        response: "Se requiere el parámetro 'jid' del chat"
      });
    }

    console.log(`🚀 Iniciando sincronización completa para: ${jid}`);
    
    // Ejecutar sincronización en background y devolver respuesta inmediata
    res.status(200).json({
      status: true,
      response: "Sincronización iniciada en background",
      jid: jid,
      message: "Revisa los logs de la consola para ver el progreso"
    });
    
    // Ejecutar sincronización sin bloquear la respuesta
    syncFullChatHistory(jid, parseInt(maxMessages) || 1000)
      .then(result => {
        console.log(`✅ Sincronización completada para ${jid}:`, result);
      })
      .catch(error => {
        console.error(`❌ Error en sincronización de ${jid}:`, error);
      });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// 🔄 ENDPOINT PARA SINCRONIZAR MI PROPIO CHAT (chat conmigo mismo)
app.post("/sync-my-chat-full", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    const myJid = getMyJid();
    if (!myJid) {
      return res.status(500).json({
        status: false,
        response: "No se pudo obtener tu JID"
      });
    }

    const { maxMessages } = req.body;
    
    console.log(`🚀 Iniciando sincronización completa de mi chat: ${myJid}`);
    
    res.status(200).json({
      status: true,
      response: "Sincronización de tu chat iniciada en background",
      myJid: myJid,
      message: "Revisa los logs de la consola para ver el progreso"
    });
    
    // Ejecutar sincronización
    syncFullChatHistory(myJid, parseInt(maxMessages) || 1000)
      .then(result => {
        console.log(`✅ Tu chat sincronizado completamente:`, result);
      })
      .catch(error => {
        console.error(`❌ Error sincronizando tu chat:`, error);
      });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// 🔄 ENDPOINT PARA SINCRONIZAR MÚLTIPLES CHATS
app.post("/sync-multiple-chats", async (req, res) => {
  try {
    const { jids, maxMessagesPerChat } = req.body;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp"
      });
    }

    if (!jids || !Array.isArray(jids) || jids.length === 0) {
      return res.status(400).json({
        status: false,
        response: "Se requiere un array 'jids' con los chats a sincronizar"
      });
    }

    console.log(`🚀 Iniciando sincronización múltiple para ${jids.length} chats`);
    
    res.status(200).json({
      status: true,
      response: `Sincronización iniciada para ${jids.length} chats`,
      jids: jids,
      message: "Revisa los logs de la consola para ver el progreso"
    });
    
    // Ejecutar sincronización múltiple
    syncMultipleChats(jids, parseInt(maxMessagesPerChat) || 500)
      .then(results => {
        console.log(`✅ Sincronización múltiple completada:`, results);
      })
      .catch(error => {
        console.error(`❌ Error en sincronización múltiple:`, error);
      });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});




// 📊 ENDPOINT PARA VER PROGRESO DE SINCRONIZACIÓN
app.get("/sync-status/:jid", async (req, res) => {
  try {
    const { jid } = req.params;
    
    if (!jid) {
      return res.status(400).json({
        status: false,
        response: "Se requiere el JID del chat"
      });
    }

    const messages = messageStore[jid] || [];
    const imageCount = messages.filter(msg => msg.message?.imageMessage).length;
    const videoCount = messages.filter(msg => msg.message?.videoMessage).length;
    const textCount = messages.filter(msg => msg.message?.conversation || msg.message?.extendedTextMessage).length;
    
    const oldestMessage = messages.length > 0 ? messages[0] : null;
    const newestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    
    res.status(200).json({
      status: true,
      jid: jid,
      stats: {
        totalMessages: messages.length,
        images: imageCount,
        videos: videoCount,
        textMessages: textCount,
        timeRange: {
          oldest: oldestMessage?.messageTimestamp || null,
          newest: newestMessage?.messageTimestamp || null,
          oldestDate: oldestMessage ? new Date(oldestMessage.messageTimestamp * 1000).toISOString() : null,
          newestDate: newestMessage ? new Date(newestMessage.messageTimestamp * 1000).toISOString() : null
        }
      }
    });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// � ENDPOINT PRINCIPAL PARA EXTRAER DATOS DE THIAGO AUTOMÁTICAMENTE
app.get("/sync-data-history", async (req, res) => {
  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "No estás conectado a WhatsApp. Visita /scan para conectar."
      });
    }

    const contactName = "Thiago";
    const messageLimit = 10;
    
    console.log(`🚀 Iniciando extracción automática de ${contactName} (últimos ${messageLimit} mensajes)...`);
    
    // Respuesta inmediata
    res.status(200).json({
      status: true,
      response: `Extracción automática iniciada para ${contactName}`,
      contactName: contactName,
      messageLimit: messageLimit,
      message: "Revisa los logs de la consola para ver el progreso"
    });
    
    // Ejecutar extracción en background
    extractThiagoMessagesAutomatically(messageLimit)
      .then(result => {
        console.log(`✅ Extracción de ${contactName} completada:`, result);
      })
      .catch(error => {
        console.error(`❌ Error extrayendo mensajes de ${contactName}:`, error);
      });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// �🔄 ENDPOINT PARA SCRAPER HÍBRIDO PUPPETEER + BAILEYS
app.post("/hybrid-extraction", async (req, res) => {
  try {
    const { puppeteerDataPath, contactJID, contactName, config } = req.body;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "Baileys no está conectado a WhatsApp"
      });
    }

    if (!puppeteerDataPath || !contactJID || !contactName) {
      return res.status(400).json({
        status: false,
        response: "Se requieren: puppeteerDataPath, contactJID, contactName"
      });
    }

    console.log(`🚀 Iniciando extracción híbrida para: ${contactName} (${contactJID})`);
    
    // Respuesta inmediata
    res.status(200).json({
      status: true,
      response: "Extracción híbrida iniciada en background",
      contactName: contactName,
      contactJID: contactJID,
      message: "Revisa los logs de la consola para ver el progreso"
    });
    
    // Ejecutar extracción híbrida en background
    const HybridWhatsAppScraper = require('./hybrid-scraper');
    const hybridScraper = new HybridWhatsAppScraper({
      downloadImages: true,
      downloadVideos: true,
      outputDir: './hybrid-output',
      baileysSession: 'session_auth_info',
      logLevel: 'silent',
      ...config
    });
    
    // Usar el socket actual en lugar de crear uno nuevo
    hybridScraper.baileysSocket = sock;
    
    hybridScraper.processHybridExtraction(puppeteerDataPath, contactJID, contactName)
      .then(result => {
        if (result.success) {
          console.log(`✅ Extracción híbrida completada para ${contactName}:`, result.stats);
        } else {
          console.error(`❌ Error en extracción híbrida de ${contactName}:`, result.error);
        }
      })
      .catch(error => {
        console.error(`❌ Error inesperado en extracción híbrida:`, error);
      });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// 🔄 ENDPOINT PARA PROCESAR DATOS DE PUPPETEER CON BAILEYS
app.post("/process-puppeteer-data", async (req, res) => {
  try {
    const { puppeteerData, contactJID, contactName } = req.body;
    
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "Baileys no está conectado a WhatsApp"
      });
    }

    if (!puppeteerData || !contactJID || !contactName) {
      return res.status(400).json({
        status: false,
        response: "Se requieren: puppeteerData (array), contactJID, contactName"
      });
    }

    console.log(`🔄 Procesando ${puppeteerData.length} mensajes de Puppeteer para ${contactName}...`);
    
    // Respuesta inmediata
    res.status(200).json({
      status: true,
      response: "Procesamiento de datos de Puppeteer iniciado",
      contactName: contactName,
      messagesCount: puppeteerData.length,
      message: "Revisa los logs para ver el progreso"
    });
    
    // Procesar en background
    processHybridDataInBackground(puppeteerData, contactJID, contactName)
      .then(result => {
        console.log(`✅ Procesamiento completado para ${contactName}:`, result);
      })
      .catch(error => {
        console.error(`❌ Error en procesamiento:`, error);
      });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      response: error.message
    });
  }
});

// 🔧 FUNCIÓN PRINCIPAL PARA EXTRAER MENSAJES DE THIAGO AUTOMÁTICAMENTE
async function extractThiagoMessagesAutomatically(messageLimit = 10) {
  try {
    const contactName = "Thiago";
    console.log(`🎯 Buscando JID de ${contactName}...`);
    
    // Buscar el JID de Thiago en los contactos
    let thiagoJID = "51912135590@s.whatsapp.net";
    
       
    // Si no encontramos el JID automáticamente, usar un JID de ejemplo
    // ⚠️ IMPORTANTE: Reemplaza este JID con el real de Thiago
    if (!thiagoJID) {
      // Puedes obtener el JID real ejecutando /get-chats primero
      thiagoJID = "51912135590@s.whatsapp.net"; // ⚠️ REEMPLAZA CON EL JID REAL
      console.log(`⚠️ Usando JID predeterminado: ${thiagoJID}`);
      console.log(`💡 Tip: Ejecuta /get-chats para obtener el JID real de Thiago`);
    }
    
    console.log(`📱 Extrayendo mensajes de ${contactName} (${thiagoJID})...`);
    
    // Extraer mensajes usando fetchMessageHistory
    let extractedMessages = [];
    let cursor = null;
    let totalExtracted = 0;
    
    try {
      console.log(`📦 Obteniendo últimos ${messageLimit} mensajes...`);
      
      const rawData = await sock.fetchMessageHistory(messageLimit, cursor);
      const data = JSON.parse(rawData);
      const messages = data.messages || [];
      
      console.log(`📥 Mensajes obtenidos: ${messages.length}`);
      
      // Filtrar solo mensajes de Thiago si es posible
      const thiagoMessages = messages.filter(msg => 
        msg.key.remoteJid === thiagoJID || 
        msg.key.remoteJid?.includes('thiago') ||
        msg.pushName?.toLowerCase().includes('thiago')
      );
      
      if (thiagoMessages.length === 0) {
        console.log(`⚠️ No se encontraron mensajes específicos de Thiago, usando todos los mensajes recientes`);
        extractedMessages = messages.slice(0, messageLimit);
      } else {
        console.log(`✅ Encontrados ${thiagoMessages.length} mensajes de Thiago`);
        extractedMessages = thiagoMessages.slice(0, messageLimit);
      }
      
      totalExtracted = extractedMessages.length;
      
    } catch (error) {
      console.error(`❌ Error obteniendo mensajes:`, error.message);
      
      // Fallback: usar mensajes del store si fetchMessageHistory falla
      console.log(`🔄 Intentando con messageStore...`);
      const storeMessages = messageStore[thiagoJID] || [];
      extractedMessages = storeMessages.slice(-messageLimit);
      totalExtracted = extractedMessages.length;
      console.log(`📦 Mensajes desde store: ${totalExtracted}`);
    }
    
    if (totalExtracted === 0) {
      console.log(`❌ No se encontraron mensajes para procesar`);
      return {
        success: false,
        error: "No se encontraron mensajes",
        contactName: contactName,
        thiagoJID: thiagoJID
      };
    }
    
    console.log(`📊 Analizando ${totalExtracted} mensajes extraídos...`);
    
    // Analizar y procesar mensajes
    const processedMessages = [];
    let imageCount = 0;
    let textCount = 0;
    let videoCount = 0;
    
    for (const msg of extractedMessages) {
      try {
        const messageType = getContentType(msg.message || {});
        const timestamp = msg.messageTimestamp || Date.now();
        const messageId = msg.key.id;
        const isFromMe = msg.key.fromMe;
        
        const processedMsg = {
          id: messageId,
          timestamp: timestamp,
          date: new Date(timestamp * 1000).toLocaleString(),
          isFromMe: isFromMe,
          type: messageType,
          content: null,
          hasMedia: false
        };
        
        // Procesar según el tipo de mensaje
        if (messageType === 'conversation') {
          processedMsg.content = msg.message.conversation;
          textCount++;
        } else if (messageType === 'extendedTextMessage') {
          processedMsg.content = msg.message.extendedTextMessage.text;
          textCount++;
        } else if (messageType === 'imageMessage') {
          processedMsg.hasMedia = true;
          processedMsg.content = msg.message.imageMessage.caption || '[Imagen]';
          imageCount++;
          
          // 🖼️ DESCARGAR IMAGEN AUTOMÁTICAMENTE
          await downloadImageFromMessage(msg, contactName, messageId);
          
        } else if (messageType === 'videoMessage') {
          processedMsg.hasMedia = true;
          processedMsg.content = msg.message.videoMessage.caption || '[Video]';
          videoCount++;
          
          // 🎥 DESCARGAR VIDEO AUTOMÁTICAMENTE
          await downloadVideoFromMessage(msg, contactName, messageId);
        }
        
        processedMessages.push(processedMsg);
        
      } catch (error) {
        console.error(`⚠️ Error procesando mensaje ${msg.key.id}:`, error.message);
      }
    }
    
    // Guardar reporte
    const reportData = {
      contactName: contactName,
      thiagoJID: thiagoJID,
      extractionTime: new Date().toISOString(),
      totalMessages: totalExtracted,
      processedMessages: processedMessages.length,
      stats: {
        textMessages: textCount,
        images: imageCount,
        videos: videoCount
      },
      messages: processedMessages
    };
    
    // Guardar reporte en archivo
    const reportPath = path.join(__dirname, 'thiago-extraction-report.json');
    await fs.promises.writeFile(reportPath, JSON.stringify(reportData, null, 2));
    
    console.log(`✅ Extracción completada para ${contactName}:`);
    console.log(`   📁 Reporte: ${reportPath}`);
    console.log(`   💬 Mensajes: ${totalExtracted}`);
    console.log(`   📝 Textos: ${textCount}`);
    console.log(`   🖼️ Imágenes: ${imageCount}`);
    console.log(`   🎥 Videos: ${videoCount}`);
    
    return {
      success: true,
      contactName: contactName,
      thiagoJID: thiagoJID,
      stats: reportData.stats,
      totalMessages: totalExtracted,
      reportPath: reportPath
    };
    
  } catch (error) {
    console.error(`❌ Error en extracción automática:`, error);
    return {
      success: false,
      error: error.message,
      contactName: "Thiago"
    };
  }
}

// 🖼️ FUNCIÓN PARA DESCARGAR IMAGEN DE UN MENSAJE
async function downloadImageFromMessage(message, contactName, messageId) {
  try {
    console.log(`📸 Descargando imagen ${messageId}...`);
    
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { 
        logger: console, 
        reuploadRequest: sock.updateMediaMessage 
      }
    );
    
    if (buffer) {
      const timestamp = message.messageTimestamp || Date.now();
      const caption = message.message.imageMessage?.caption || '';
      const mimetype = message.message.imageMessage?.mimetype || 'image/jpeg';
      
      let extension = '.jpg';
      if (mimetype.includes('png')) extension = '.png';
      else if (mimetype.includes('gif')) extension = '.gif';
      else if (mimetype.includes('webp')) extension = '.webp';
      
      const downloadDir = path.join(__dirname, 'thiago-downloads');
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
        downloadTime: new Date().toISOString()
      };
      
      const logPath = path.join(downloadDir, 'download_log.json');
      let logs = [];
      
      try {
        const existingLogs = await fs.promises.readFile(logPath, 'utf8');
        logs = JSON.parse(existingLogs);
      } catch (error) {
        // Archivo no existe, empezar logs vacíos
      }
      
      logs.push(downloadLog);
      await fs.promises.writeFile(logPath, JSON.stringify(logs, null, 2));
      
      console.log(`   ✅ ${fileName} descargado (${formatFileSize(buffer.length)})`);
      return { success: true, fileName: fileName, fileSize: buffer.length };
      
    } else {
      console.log(`   ❌ No se pudo descargar imagen ${messageId}`);
      return { success: false, error: 'Buffer vacío' };
    }
    
  } catch (error) {
    console.error(`   ❌ Error descargando imagen ${messageId}:`, error.message);
    return { success: false, error: error.message };
  }
}

// 🎥 FUNCIÓN PARA DESCARGAR VIDEO DE UN MENSAJE
async function downloadVideoFromMessage(message, contactName, messageId) {
  try {
    console.log(`🎬 Descargando video ${messageId}...`);
    
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { 
        logger: console, 
        reuploadRequest: sock.updateMediaMessage 
      }
    );
    
    if (buffer) {
      const timestamp = message.messageTimestamp || Date.now();
      const caption = message.message.videoMessage?.caption || '';
      const mimetype = message.message.videoMessage?.mimetype || 'video/mp4';
      
      let extension = '.mp4';
      if (mimetype.includes('avi')) extension = '.avi';
      else if (mimetype.includes('mov')) extension = '.mov';
      else if (mimetype.includes('webm')) extension = '.webm';
      
      const downloadDir = path.join(__dirname, 'thiago-downloads');
      await fs.promises.mkdir(downloadDir, { recursive: true });
      
      const fileName = `thiago_video_${timestamp}_${messageId}${extension}`;
      const filePath = path.join(downloadDir, fileName);
      
      await fs.promises.writeFile(filePath, buffer);
      
      console.log(`   ✅ ${fileName} descargado (${formatFileSize(buffer.length)})`);
      return { success: true, fileName: fileName, fileSize: buffer.length };
      
    } else {
      console.log(`   ❌ No se pudo descargar video ${messageId}`);
      return { success: false, error: 'Buffer vacío' };
    }
    
  } catch (error) {
    console.error(`   ❌ Error descargando video ${messageId}:`, error.message);
    return { success: false, error: error.message };
  }
}

// 🔧 FUNCIÓN HELPER PARA PROCESAMIENTO HÍBRIDO
async function processHybridDataInBackground(puppeteerData, contactJID, contactName) {
  try {
    console.log(`🔍 Analizando ${puppeteerData.length} mensajes de Puppeteer...`);
    
    // Analizar tipos de mensajes
    const imageMessages = puppeteerData.filter(msg => 
      msg.type === 'image' || msg.imageUrls?.length > 0
    );
    
    console.log(`🖼️ Encontrados ${imageMessages.length} mensajes con imágenes en datos de Puppeteer`);
    
    if (imageMessages.length === 0) {
      console.log(`ℹ️ No hay imágenes para descargar en los datos de ${contactName}`);
      return { success: true, downloadedImages: 0, message: 'No hay imágenes para descargar' };
    }
    
    // Buscar mensajes correspondientes en Baileys
    console.log(`🔍 Buscando mensajes con imágenes en Baileys para ${contactJID}...`);
    
    let baileysMessages = [];
    try {
      // Usar fetchMessageHistory para obtener mensajes con media
      let cursor = null;
      let batchCount = 0;
      const maxBatches = 10;
      
      while (batchCount < maxBatches) {
        const rawData = await sock.fetchMessageHistory(50, cursor);
        const data = JSON.parse(rawData);
        const messages = data.messages || [];
        
        if (messages.length === 0) break;
        
        // Filtrar solo mensajes con imágenes
        const imageMessagesInBatch = messages.filter(msg => {
          const content = getContentType(msg.message || {});
          return content === 'imageMessage';
        });
        
        baileysMessages = baileysMessages.concat(imageMessagesInBatch);
        cursor = messages[messages.length - 1].key;
        batchCount++;
        
        console.log(`   📦 Lote ${batchCount}: ${imageMessagesInBatch.length} imágenes encontradas`);
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (error) {
      console.error(`❌ Error obteniendo mensajes de Baileys:`, error.message);
      return { success: false, error: error.message };
    }
    
    console.log(`🎯 Total de imágenes en Baileys: ${baileysMessages.length}`);
    
    // Descargar imágenes
    if (baileysMessages.length > 0) {
      const downloadResults = await downloadImagesFromBaileysMessages(
        baileysMessages, 
        contactName,
        imageMessages
      );
      
      return {
        success: true,
        downloadedImages: downloadResults.successful,
        errors: downloadResults.errors,
        totalPuppeteerImages: imageMessages.length,
        totalBaileysImages: baileysMessages.length
      };
    } else {
      return {
        success: true,
        downloadedImages: 0,
        message: 'No se encontraron imágenes correspondientes en Baileys'
      };
    }
    
  } catch (error) {
    console.error(`❌ Error en procesamiento híbrido:`, error);
    return { success: false, error: error.message };
  }
}

// 🔧 FUNCIÓN PARA DESCARGAR IMÁGENES DE MENSAJES DE BAILEYS
async function downloadImagesFromBaileysMessages(baileysMessages, contactName, puppeteerImageMessages) {
  const fs = require('fs').promises;
  const downloadDir = path.join(__dirname, 'hybrid-downloads', contactName);
  
  // Crear directorio
  try {
    await fs.mkdir(downloadDir, { recursive: true });
  } catch (error) {
    console.error(`❌ Error creando directorio:`, error);
  }
  
  let successful = 0;
  let errors = 0;
  const downloadLog = [];
  
  console.log(`📥 Iniciando descarga de ${baileysMessages.length} imágenes...`);
  
  for (let i = 0; i < baileysMessages.length; i++) {
    const msg = baileysMessages[i];
    
    try {
      console.log(`📸 Descargando imagen ${i + 1}/${baileysMessages.length}...`);
      
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { 
          logger: console, 
          reuploadRequest: sock.updateMediaMessage 
        }
      );
      
      if (buffer) {
        const timestamp = msg.messageTimestamp || Date.now();
        const messageId = msg.key.id;
        const caption = msg.message.imageMessage?.caption || '';
        const mimetype = msg.message.imageMessage?.mimetype || 'image/jpeg';
        
        let extension = '.jpg';
        if (mimetype.includes('png')) extension = '.png';
        else if (mimetype.includes('gif')) extension = '.gif';
        else if (mimetype.includes('webp')) extension = '.webp';
        
        const fileName = `hybrid_${contactName}_${timestamp}_${messageId}${extension}`;
        const filePath = path.join(downloadDir, fileName);
        
        await fs.writeFile(filePath, buffer);
        
        const downloadInfo = {
          fileName: fileName,
          filePath: filePath,
          messageId: messageId,
          caption: caption,
          mimetype: mimetype,
          fileSize: buffer.length,
          downloadTime: new Date().toISOString()
        };
        
        downloadLog.push(downloadInfo);
        successful++;
        
        console.log(`   ✅ ${fileName} (${formatFileSize(buffer.length)})`);
        
      } else {
        console.log(`   ❌ No se pudo descargar imagen ${msg.key.id}`);
        errors++;
      }
      
    } catch (error) {
      console.error(`   ❌ Error descargando ${msg.key.id}:`, error.message);
      errors++;
    }
    
    // Pausa entre descargas
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  // Guardar log de descargas
  const logPath = path.join(downloadDir, 'hybrid_download_log.json');
  await fs.writeFile(logPath, JSON.stringify(downloadLog, null, 2));
  
  console.log(`✅ Descarga híbrida completada:`);
  console.log(`   📁 Directorio: ${downloadDir}`);
  console.log(`   ✅ Exitosas: ${successful}`);
  console.log(`   ❌ Errores: ${errors}`);
  console.log(`   📄 Log: ${logPath}`);
  
  return { successful, errors, downloadLog, downloadDir };
}

// 🔧 FUNCIÓN HELPER PARA FORMATEAR TAMAÑO DE ARCHIVO
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

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

connectToWhatsApp().catch((err) => console.log("unexpected error: " + err)); // catch any errors
server.listen(port, () => {
  console.log("Server Run Port : " + port);
});
