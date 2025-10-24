  const normalizeDateTime = (data) => {
    // data.fecha: dd/mm/yyyy (opcional)
    // data.hora:  HH:mm       (opcional)
    const now = new Date();

    // Parse fecha dd/mm/yyyy o dd-mm-yyyy
    let d, m, y;
    if (typeof data.fecha === 'string') {
      const fm = data.fecha.match(/^\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s*$/);
      if (fm) {
        d = parseInt(fm[1], 10);
        m = parseInt(fm[2], 10);
        y = parseInt(fm[3], 10);
      }
    }
    if (d == null || m == null || y == null) {
      // si no hay fecha, usar hoy
      d = now.getDate();
      m = now.getMonth() + 1;
      y = now.getFullYear();
    }

    // Parse hora HH:mm (si no hay, usar 00:00)
    let hh = 0, mm = 0;
    if (typeof data.hora === 'string') {
      const hm = data.hora.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
      if (hm) {
        hh = Math.min(23, parseInt(hm[1], 10));
        mm = Math.min(59, parseInt(hm[2], 10));
      } else if (!data.hora) {
        // si hora está ausente explícitamente, dejaremos 00:00
      }
    } else if (data.hora) {
      // si viene en otro formato no válido, también 00:00
    }

    const localDate = new Date(y, m - 1, d, hh, mm, 0, 0); // zona local del server
    const fechaStr = `${pad2(d)}/${pad2(m)}/${y}`;
    const horaStr = `${pad2(hh)}:${pad2(mm)}`;
    const iso = localDate.toISOString(); // listo para timestamptz

    return {
      ...data,
      fecha: fechaStr,
      hora: horaStr,
      fecha_iso: iso // para guardar en BD como timestamptz
    };
  };

  module.exports = {
    normalizeDateTime
  };