const similarWordsToInitDestinatarios = {
  // Panaderías y Pastelerías
  "San Benedetto,Mercedes Aquino,Benedetto,San Benetto,San Ben,Pan Benedetto": ["San Benedetto"],
  "Las Vegas,Vegas,Las veguitas,Panadería Vegas,Marco Daniel Bellonio": ["Las Vegas"],
  "Ayla Pasteleria,Aila,Isla,Ayra,Pastelería Ayla" : ["Ayla Pastelería"],
  "Panadero Mati,Mati,Pan Mati, Panadero Matias,El Mati,Matias Ezequiel Rodriguez" : ["Panadero Mati"],
  "Pastelera Caty,Kitty,Kitti,Kiti,Catty,Catty Victoria Cobos,Kity Pastelera,Pastelería Kitty,Ki": ["Pastelera Kity"],

  // Dietéticas y mayoristas
  "Lg distribuidora,LG,Distribuidora LG,Elge,Lg mayorista": ["Lg distribuidora"],
  "Oveja Negra,La Oveja,Dietética Oveja": ["Oveja Negra"],

  // Fiambrería y Lácteos
  "Amanecer Terminal 12,Amanecer,Terminal 12,Fiambrería Amanecer": ["Amanecer Terminal 12"],
  "Veronica,Vero,Vero lácteos,Vero Quesos": ["Veronica"],
  "Ariel huevos,Ariel,Huevero Ariel,Ariel H, El de huevos": ["Ariel huevos"],
  
  // Descartables
  "Papelera Puerto,Papelera,Puerto,Papel Puerto": ["Papelera Puerto"],
  "Mugme,Mug Me,Tazas Mugme,Mug,Mugs,Descartables Mug": ["Mugme"],

  // Limpieza
  "Limpimax,Limpi Max,Limpio Max,Limpieza Max": ["Limpimax"],

  // Verdulerías
  "Maxnic,Max,Maxik,Verdulería Max": ["Maxnic"],
  "San Carlos,Carlos,Verdulería Carlos,SanCa,Miguelina Noemi Gauna, Miguelina": ["San Carlos"],
  "Super ola,Ola,Mayorista Ola,Súper ola,Caren Lucia Navarrete Bordon,Caren Lucia": ["Super ola"],
  
  // Almacén y despensa
 "Walter 24 hs,24hs,Almacén Walter,Griselda Mabel Ramos": ["Walter 24 hs"],
 "Walter garrafas,": ["Walter garrafas"],
  "Las grutas,Grutas,Grutitas,Almacén Grutas": ["Las grutas"],
  "Lo de Pio,Pio,Pío,Lo de Pío,Despensa Pio": ["Lo de Pio"],
  "Vallecito,El vallecito,Agua Vallecito,Soda Vallecito": ["Vallecito"],
  "Coto,Super Coto,Koto,Cotto": ["Coto"],
  "Cooperativa obrera supermercado,Cooperativa,Coop,Super Coop": ["Cooperativa obrera supermercado"],

  // Servicios fijos
  "Edea,Luz,Edea servicio,Factura Edea": ["Edea"],
  "Cooperativa unión del sud,Unión del sur,Internet Unión,Coop Sud": ["Cooperativa unión del sud"],
  "Fudo,Sistema Fudo,Foodoo,App Fudo": ["Fudo"],
  "Alquiler Surfranch y Palto,Alquiler,Surfranch,Palto alquiler,Cristian alquiler,Darío alquiler": ["Alquiler Surfranch y Palto"],
  "Increa,Increas,Mobiliario Increa": ["Increa"],
  "Martin,Martín,Café Martín,Granos Martin": ["Martin"],
  "Zuelo,Aceite Zuelo,Oliva Zuelo": ["Zuelo"],

  // Imprentas
  "Muin, Muin imprenta,Imprenta Muin": ["Muin"],
  "3 Juanas,Tres Juanas,Las Juanas,3J": ["3 Juanas"],

  // Ferreterías y construcción
  "Laf ferretería,Laf,LAF,Ferretería Laf": ["Laf ferretería"],
  "La Victoria ferretería,Victoria,Ferretería Victoria": ["La Victoria ferretería"],
  "La Serena,Serena,Corralón Serena,Materiales Serena": ["La Serena"],

  // Otros
  "Mercado Libre,Mercadolibre,MLi,Mercado,Libre": ["Mercado Libre"],
  
  // Empleados - Salón
  ["Iara"]: ["Iara","Ia","Iara Aixa Davila","Iara Aixa"],
  ["Sol"]: ["Sol", "Sol del cielo zoe Giangreco"],
  ["Jorgelina"]: ["Jorge", "Jor", "Jorge Lina", "Jor Gelina"],
  ["Tamara"]: ["Tamy", "Tami"],
  ["Valentina"]: ["Vale", "Valen", "Val"],
  ["Santi"]: ["Santiago", "Santy"],
  ["Lu"]: ["Lucía", "Lucre", "Lupe"],

  // Empleados - Cocina
  ["Cami"]: ["Camila", "Camy", "Camo", "Camila Roldan"],
  ["Marcelo Alejandro Dosso"]: ["Alejandra", "Alejo", "Alex"],
  ["Gueta"]: ["El Gueta", "Gueta Cocina", "Güeta", "Jeremias Leonel Elgueta"],
  ["Zahira"]: ["Zahi", "Za", "Zaira"],

  // Mantenimiento

  ["Seki"]: ["Secchi", "Sequi"],
  ["Marce"]: ["Marcelo", "Marcel"],

  // Colaboradores (Servicios ocasionales)
  "Cocineros eventos,Cocina eventos,Cocinerxs,Cocineros": ["Cocineros eventos"],
  "DJ / músicos,DJ,Músicos,Disc jockey,Banda": ["DJ / músicos"],
  "Sonidistas,Sonido,Sonidista": ["Sonidistas"],
  "Artistas,Artista,Pintores,Performers": ["Artistas"],
  "Profe Cerámica,Cerámica,Profesora cerámica,Ceramistas": ["Profe Cerámica"],

  // Surfranch - Otros proveedores
  "Kevin Kiosko,Kevin," : ["Kevin Kiosko"],
  "Raul,Raúl,Lavandería Raúl,Lavadero Raúl": ["Raul"],
  "La lujanera,Lujanera,Cloacas,Desagote Lujanera": ["La lujanera"],
  "Otros,Otro proveedor,Varios,Otros gastos": ["Otros"],
};

module.exports = similarWordsToInitDestinatarios;