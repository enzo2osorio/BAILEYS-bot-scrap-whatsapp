const supabase = require("./supabase");

async function saveDataFirstFlow(params) {
   
    const {nombre:nombre_destino, monto, fecha, hora, tipo_movimiento, medio_pago, observacion} = params
 

    const {data: existingDestinatario, error} = await supabase
                                        .from("destinatarios")
                                        .select("*")
                                        .eq('name', nombre_destino);
                          
    console.log("Destinatario encontrado:", existingDestinatario);

   if(!existingDestinatario || existingDestinatario.length === 0){
    return {error: "No existe el destinatario."};
   }

   const {data: existingMedioPago, error: errorMedioPago} = await supabase
                                        .from("metodos_pago")
                                        .select("*")
                                        .eq('name', medio_pago)
                                        .single();

   if(!existingMedioPago){
    return {error: "No existe el medio de pago."};
    }


   // Convertir fecha de dd/mm/yyyy a yyyy-mm-dd para PostgreSQL
   let fechaFormatted = null;
   if (fecha) {
     const [day, month, year] = fecha.split('/');
     fechaFormatted = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
   }

   // Tomar el primer destinatario del array
   const destinatario = existingDestinatario[0];

   const {data : dataRegistro, error: errorRegistro} = await supabase.
                                        from("registros").
                                        insert(
                                            {
                                                destinatario_id: destinatario.id,
                                                monto,
                                                fecha: fechaFormatted,
                                                tipo_movimiento,
                                                metodo_pago_id: existingMedioPago.id,
                                                descripcion: observacion,
                                                created_at: new Date().toISOString()
                                            }
                                        )


   if(errorRegistro){
    console.log({errorRegistro})
       return {error: "Error al guardar el registro."};
   }

   console.log("se guardoooOooOo")

   return {success : true, data: dataRegistro}; // Retorna el registro guardado o un mensaje de éxito
}  

module.exports = saveDataFirstFlow;
