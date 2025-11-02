    const pad2 = (n) => String(n).padStart(2, '0');

  const normalizeDateTime = (data) => {
    // data.fecha: dd/mm/yyyy (opcional)
    // data.hora:  HH:mm       (opcional)
    const now = new Date();
    const isModification = !!data.recordId; // Si tiene recordId es una modificación

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
    
    // CRÍTICO: Si es modificación y no se pudo parsear la fecha, intentar preservar la original
    if (d == null || m == null || y == null) {
      if (isModification && data.fecha_iso) {
        // Si es modificación y tiene fecha ISO original, preservarla
        try {
          const originalDate = new Date(data.fecha_iso);
          d = originalDate.getDate();
          m = originalDate.getMonth() + 1;
          y = originalDate.getFullYear();
        } catch (error) {
          console.warn('Error preservando fecha original, usando fecha actual');
          d = now.getDate();
          m = now.getMonth() + 1;
          y = now.getFullYear();
        }
      } else {
        // si no hay fecha y no es modificación, usar hoy
        d = now.getDate();
        m = now.getMonth() + 1;
        y = now.getFullYear();
      }
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