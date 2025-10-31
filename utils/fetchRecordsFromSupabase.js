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
        cuenta_contable_id,        
      `)
      .eq('origen', 'bot')
      .gte('fecha', startISO)
      .lte('fecha', endISO)
      .order('fecha', { ascending: true })
      .range(offset, offset + limit - 1);
    
    if (error) {
      console.error('❌ Error obteniendo registros:', error);
      return { records: [], totalCount: count || 0, hasMore: false };
    }

    const registrosWDestinatarios = await Promise.all(records.map(async (async registro => {
        const destinatarioName = await supabase.from('destinatarios')
          .select('name')
          .eq('id', registro.destinatario_id)
          .maybeSingle();
        return { ...registro, destinatarioName };
    })))

    const previousRegistrosWCuentasContables = await Promise.all(registrosWDestinatarios.map(async(registro) => {
        const cuentaContableName = await findCuentaLinkByIds(registro.destinatario_id, registro.metodo_pago_id);
        return { ...registro, cuentaContableName: cuentaContableName?.description || null };
    }))
    
    const hasMore = (offset + limit) < (count || 0);
    
    return { 
      records: previousRegistrosWCuentasContables || [], 
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
        const destinatarioName = await getDestinatarios(registro.destinatario_id);
        return { ...registro, destinatario_name: destinatarioName };
    }))

    const previousRegistrosWCuentasContables = await Promise.all(registrosWDestinatarios.map(async(registro) => {
        const cuentaContableInfo = await findCuentaLinkByIds(registro.destinatario_id, registro.metodo_pago_id);
        
        //podria haber spliteado la descripcion, ya que todos siguen el formato "metodo pago - de - destinatario",
        // pero prefiero hacerlo bien con querys, por si se cambia ese formato. 
        const cuentaName = await supabase
          .from('destinatarios')
          .select('name')
          .eq('id', cuentaContableInfo?.destinatario_id)
          .maybeSingle();
        
        return { ...registro, cuenta_description: cuentaContableInfo?.description || null, cuenta_owner_name: cuentaName?.data?.name || null };
    }))
    
    const previosRegistrosWMedioPago = await Promise.all(previousRegistrosWCuentasContables.map(async (registro) => {
        const medioPagoName = await supabase
          .from('metodos_pago')
          .select('name')
          .eq('id', registro.metodo_pago_id)
          .maybeSingle();
        return { ...registro, medio_pago: medioPagoName?.data?.name || null };
    }))

    return previosRegistrosWMedioPago;
    
  } catch (error) {
    console.error('❌ Error en fetchRecordsWithAllStuff:', error);
    return [];
  }
}

module.exports = { fetchRecordsWithAllStuff, fetchRecordWithAllStuffById};


