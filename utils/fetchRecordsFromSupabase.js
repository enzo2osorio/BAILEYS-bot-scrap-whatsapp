const supabase = require("../supabase");
const { getDestinatarios } = require("./destinatarios/getDestinatarios");
const { findCuentaLinkByIds } = require("./destinatarios/resolveCuentaContableDescripcion");

async function fetchRecordsWithAllStuff(startDate, endDate, offset = 0, limit = 50) {
  try {
    // Expandir rango de fechas para incluir registros con hora 00:00:00
    // Fecha inicio: empezar desde 23:59:50 del día anterior
    const expandedStartDate = new Date(startDate);
    expandedStartDate.setDate(expandedStartDate.getDate() - 1);
    expandedStartDate.setHours(23, 59, 50, 0); // 10 segundos antes del día
    
    // Fecha fin: terminar a las 23:59:59 del día especificado
    const expandedEndDate = new Date(endDate);
    expandedEndDate.setHours(23, 59, 59, 999); // Final del día
    
    // Convertir a formato ISO para Supabase
    const startISO = expandedStartDate.toISOString();
    const endISO = expandedEndDate.toISOString();
    
    console.log(`🔍 Buscando registros entre: ${startISO} y ${endISO}`);
    
    // Contar total de registros en el rango expandido
    const { count, error: countError } = await supabase
      .from('registros')
      .select('*', { count: 'exact', head: true })
      .eq('origen', 'bot')
      .gte('fecha', startISO)
      .lte('fecha', endISO);
    
    if (countError) {
      console.error('❌ Error contando registros:', countError);
      return { records: [], totalCount: 0, hasMore: false };
    }
    
    const { data: records, error } = await supabase
      .from('registros')
      .select(`
        id,
        destinatario_id,
        monto,
        fecha,
        tipo_movimiento,
        metodo_pago_id,
        cuenta_contable_id`)
      .eq('origen', 'bot')
      .gte('fecha', startISO)
      .lte('fecha', endISO)
      .order('fecha', { ascending: true })
      .range(offset, offset + limit - 1);
    
    if (error) {
      console.error('❌ Error obteniendo registros:', error);
      return { records: [], totalCount: count || 0, hasMore: false };
    }

    const formatedRecords = records.map(record => ({
      ...record,
      fecha: record.fecha
        ? new Date(record.fecha).toLocaleDateString('es-ES', {
            day: '2-digit',
            month: '2-digit', 
            year: 'numeric'
          }).replace(/\//g, '/')
        : null
}));

    const registrosWDestinatarios = await Promise.all(formatedRecords.map(async (registro) => {
        const { data: destinatario } = await supabase.from('destinatarios')
          .select('name')
          .eq('id', registro.destinatario_id)
          .maybeSingle();
        return { 
          ...registro, 
          destinatario_nombre: destinatario?.name || 'Sin destinatario'
        };
    }));

    const registrosWMetodoPago = await Promise.all(registrosWDestinatarios.map(async(registro) => {
        const { data: metodoPago } = await supabase.from('metodos_pago')
          .select('name')
          .eq('id', registro.metodo_pago_id)
          .maybeSingle();
        return { 
          ...registro, 
          metodo_pago_nombre: metodoPago?.name || 'Sin método de pago'
        };
    }));

    const registrosWCuentaContable = await Promise.all(registrosWMetodoPago.map(async(registro) => {
        const {data : cuentaContableInfo, error: errorCuentaContable} = await supabase.from('metodo_pago_destinatario_duenos')
          .select('description, destinatario_id')
          .eq('id', registro.cuenta_contable_id)
          .maybeSingle();
        
          if (errorCuentaContable) {
            console.error('❌ Error obteniendo cuenta contable info :', errorCuentaContable);
          }

        // Obtener nombre del dueño/destinatario
        const { data: dueno, error } = await supabase.from('destinatarios')
          .select('name')
          .eq('id', cuentaContableInfo?.destinatario_id)
          .maybeSingle();
        
          if (error) {
            console.error('❌ Error obteniendo nombre del dueño :', error);
          }

        return { 
          ...registro, 
          cuenta_contable_descripcion: cuentaContableInfo?.description,
          dueno_nombre: dueno?.name
        };
    }));
    
    const hasMore = (offset + limit) < (count || 0);
    
    

    return { 
      records: registrosWCuentaContable || [], 
      totalCount: count || 0, 
      hasMore 
    };
    
  } catch (error) {
    console.error('❌ Error en fetchRecordsFromSupabase:', error);
    return { records: [], totalCount: 0, hasMore: false };
  }
}

async function fetchRecordWithAllStuffById(recordId) {
  try {
    
    const { data: singleRecord, error } = await supabase
      .from('registros')
      .select("*")
      .eq('id', recordId)
      .single();

    if (error) {
      console.error('❌ Error obteniendo registro por ID:', error);
      return null;
    }

    if (!singleRecord) {
      console.log('❌ No se encontró el registro con ID:', recordId);
      return null;
    }

    // Obtener destinatario
    const { data: destinatario } = await supabase.from('destinatarios')
      .select('name')
      .eq('id', singleRecord.destinatario_id)
      .maybeSingle();

    // Obtener información de cuenta contable
    const { data: cuentaContableInfo, error: errorCuentaContable } = await supabase.from('metodo_pago_destinatario_duenos')
      .select('description, destinatario_id')
      .eq('id', singleRecord.cuenta_contable_id)
      .maybeSingle();

    if (errorCuentaContable) {
      console.error('❌ Error obteniendo cuenta contable info:', errorCuentaContable);
    }

    // Obtener nombre del dueño/destinatario
    const { data: dueno, error: errorDueno } = await supabase.from('destinatarios')
      .select('name')
      .eq('id', cuentaContableInfo?.destinatario_id)
      .maybeSingle();

    if (errorDueno) {
      console.error('❌ Error obteniendo nombre del dueño:', errorDueno);
    }

    // Obtener método de pago
    const { data: metodoPago } = await supabase.from('metodos_pago')
      .select('name')
      .eq('id', singleRecord.metodo_pago_id)
      .maybeSingle();

    // Retornar objeto único completo
    return {
      ...singleRecord,
      destinatario_nombre: destinatario?.name || 'Sin destinatario',
      cuenta_contable_descripcion: cuentaContableInfo?.description || null,
      dueno_nombre: dueno?.name || null,
      metodo_pago_nombre: metodoPago?.name || 'Sin método de pago'
    };
    
  } catch (error) {
    console.error('❌ Error en fetchRecordWithAllStuffById:', error);
    return null;
  }
}

module.exports = { fetchRecordsWithAllStuff, fetchRecordWithAllStuffById};


