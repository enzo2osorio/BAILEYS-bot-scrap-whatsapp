const fuzzball = require("fuzzball");
const supabase = require("../supabase");

async function matchDestinatario(input, umbralClave = 0.65, umbralVariante = 0.9) {
  // 1️⃣ Normalizar el input
  if (!input || typeof input !== "string") {
    return { clave: null, scoreClave: 0, scoreVariante: 0, metodo: null };
  }
  const normalizado = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  // 2️⃣ Traer todos los destinatarios con sus aliases
  // Usamos una RPC o directamente agrupamos en JS
  // Aquí lo hacemos en dos queries simples:
  const { data: grouped, error: rpcErr } = await supabase
  .rpc("get_aliases_grouped");
if (rpcErr) throw rpcErr;

// grouped: [{ destinatario_id, aliases: [...] }, …]

const { data: destRows, error: destErr } = await supabase
  .from("destinatarios")
  .select("id, name");
if (destErr) throw destErr;

// 3️⃣ Construir el map directamente con la info ya agrupada
const mapDest = new Map();
for (const { id, name } of destRows) {
  // Busca si el RPC te devolvió aliases para este id
  const group = grouped.find(g => g.destinatario_id === id);
  mapDest.set(
    id,
    {
      nombreCanonical: name,
      aliases: group ? group.aliases : []
    }
  );
}

// 4️⃣ Aplanar para búsqueda es igual:
const listaSinonimos = [];
for (const [id, { nombreCanonical, aliases }] of mapDest) {
  listaSinonimos.push({ textoOriginal: nombreCanonical, id, nombreCanonical });
  for (const a of aliases) {
    listaSinonimos.push({ textoOriginal: a, id, nombreCanonical });
  }
}

  // 5️⃣ Extraer con fuzzball
  const textos = listaSinonimos.map((x) => x.textoOriginal);
  const resultados = fuzzball.extract(normalizado, textos, {
    scorer: fuzzball.ratio,
    returnObjects: true,
  });

  // 6️⃣ Filtrar por umbralClave
  const candidatos = resultados
    .filter((r) => r.score / 100 >= umbralClave)
    .map((r) => {
      const item = listaSinonimos.find((x) => x.textoOriginal === r.choice);
      return {
        ...r,
        id: item.id,
        nombreCanonical: item.nombreCanonical,
        score: r.score / 100,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (candidatos.length === 0) {
    return { clave: null, scoreClave: 0, scoreVariante: 0, metodo: null };
  }

  // 7️⃣ Tomar el mejor match y luego verificar variantes
  const mejor = candidatos[0];
  const scoreClave = mejor.score;
  const variantes = mapDest.get(mejor.id).aliases;
  const varRes = fuzzball.extract(normalizado, variantes, {
    scorer: fuzzball.ratio,
    returnObjects: true,
  });
  const mejorVar = varRes.length ? varRes.sort((a, b) => b.score - a.score)[0] : null;
  const scoreVariante = mejorVar ? mejorVar.score / 100 : 0;

  // 8️⃣ Decidir método
  if (scoreVariante >= umbralVariante) {
    return {
      clave: mejor.nombreCanonical,
      scoreClave,
      scoreVariante,
      metodo: "variante",
    };
  }
  if (scoreClave >= umbralVariante) {
    return {
      clave: mejor.nombreCanonical,
      scoreClave,
      scoreVariante,
      metodo: "clave",
    };
  }

  // Por defecto devolvemos la canonical si supera al menos umbralClave
  return {
    clave: mejor.nombreCanonical,
    scoreClave,
    scoreVariante,
    metodo: "clave",
  };
}

module.exports = matchDestinatario;