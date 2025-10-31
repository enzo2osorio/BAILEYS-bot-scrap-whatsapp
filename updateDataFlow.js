const supabase = require("./supabase");

async function getDestinatarioIdByName(destinatarioName) {
    
    const { data: destinatario, error } = await supabase
        .from('destinatarios')
        .select('id')
        .eq('name', destinatarioName)
        .single();

    if (error) {
        console.error("❌ Error obteniendo destinatario_id por name:", error);
        return null;
    }
    return destinatario.id;
}


async function getMetodoPagoIdByName(metodoPagoName) {
    const { data: metodoPago, error } = await supabase
        .from('metodos_pago')
        .select('id')
        .eq('name', metodoPagoName)
        .single();
    if (error) {
        console.error("❌ Error obteniendo metodo_pago_id por name:", error);
        return null;
    }
    return metodoPago.id;
}

async function getCuentaContableIdByName(cuentaContableDescription) {
    const { data: cuentaContable, error } = await supabase
        .from('metodo_pago_destinatario_duenos')
        .select('id')
        .eq('description', cuentaContableDescription)
        .single();

    if (error) {
        console.error("❌ Error obteniendo cuenta_contable_id por name:", error);
        return null;
    }
    return cuentaContable.id;
}

async function updatingDataFlow(updateData) {

    const newDestinatarioId = await getDestinatarioIdByName(updateData.nombre);
    const newMetodoPagoId = await getMetodoPagoIdByName(updateData.medio_pago);
    const newCuentaContableId = await getCuentaContableIdByName(updateData.cuenta_contable);    

    const { data, error } = await supabase
        .from('registros')
        .update({
            destinatario_id: newDestinatarioId,
            monto: updateData.monto,
            fecha: updateData.fecha,
            tipo_movimiento: updateData.tipo_movimiento,
            metodo_pago_id: newMetodoPagoId,
            cuenta_contable_id: newCuentaContableId,
            fecha: updateData.fecha_iso,
            updated_at: new Date().toISOString()
        })
        .eq('id', recordId)
        .select();

        if (error) {
        return { success: false, message: 'Error actualizando registro', error };
      } else {
        return { success: true, message: 'Registro actualizado exitosamente', data };
      }

}

module.exports = { updatingDataFlow };