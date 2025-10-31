const supabase = require("../supabase");
const { getDestinatarios } = require("./destinatarios/getDestinatarios");
const { findCuentaLinkByIds } = require("./destinatarios/resolveCuentaContableDescripcion");

async function fetchRecordsWithAllStuff(startDate, endDate, offset = 0, limit = 50) {
  try {
    // Convertir fechas a formato ISO para Supabase
    const startISO = startDate.toISOString().split('T')[0];
    const endISO = endDate.toISOString().split('T')[0];
    
    // Contar total de registros en el rango
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

    const registrosWDestinatarios = await Promise.all(records.map(async (registro) => {
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
        const cuentaInfo = await findCuentaLinkByIds(registro.destinatario_id, registro.metodo_pago_id);
        
        // Obtener nombre del dueño/destinatario
        const { data: dueno } = await supabase.from('destinatarios')
          .select('name')
          .eq('id', registro.cuenta_contable_id || registro.destinatario_id)
          .maybeSingle();
        
        return { 
          ...registro, 
          cuenta_contable_descripcion: cuentaInfo?.description || `${registro.metodo_pago_nombre} de ${dueno?.name || 'Sin dueño'}`,
          dueno_nombre: dueno?.name || 'Sin dueño'
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

async function fetchRecordWithAllStuffById( recordId) {
  try {
    
    const { data: singleRecord, error } = await supabase
      .from('registros')
      .select("*")
      .eq('id', recordId)
      .single();


    if (error) {
      console.error('❌ Error obteniendo registro por ID:', error);
      return [];
    }

    const registrosWDestinatarios = await Promise.all([singleRecord].map(async (registro) => {
        const { data: destinatario } = await supabase.from('destinatarios')
          .select('name')
          .eq('id', registro.destinatario_id)
          .maybeSingle();
        return { 
          ...registro, 
          destinatario_nombre: destinatario?.name || 'Sin destinatario'
        };
    }));

    const registrosWCuentaContable = await Promise.all(registrosWDestinatarios.map(async(registro) => {
        const cuentaContableInfo = await findCuentaLinkByIds(registro.destinatario_id, registro.metodo_pago_id);
        
        // Obtener nombre del dueño/destinatario de la cuenta contable
        const { data: dueno } = await supabase
          .from('destinatarios')
          .select('name')
          .eq('id', cuentaContableInfo?.destinatario_id || registro.destinatario_id)
          .maybeSingle();
        
        return { 
          ...registro, 
          cuenta_contable_descripcion: cuentaContableInfo?.description || null, 
          dueno_nombre: dueno?.name || null 
        };
    }));
    
    const registrosWMedioPago = await Promise.all(registrosWCuentaContable.map(async (registro) => {
        const { data: metodoPago } = await supabase
          .from('metodos_pago')
          .select('name')
          .eq('id', registro.metodo_pago_id)
          .maybeSingle();
        return { 
          ...registro, 
          metodo_pago_nombre: metodoPago?.name || null 
        };
    }));

    return registrosWMedioPago;
    
  } catch (error) {
    console.error('❌ Error en fetchRecordsWithAllStuff:', error);
    return [];
  }
}

module.exports = { fetchRecordsWithAllStuff, fetchRecordWithAllStuffById};


