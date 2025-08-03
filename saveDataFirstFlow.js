const supabase = require("./supabase");

async function saveDataFirstFlow(params) {
   
    const {nombre:nombre_destino, monto, fecha, hora, tipo_movimiento, medio_pago, observacion} = params

    const mercado_pago_id = '3dd836b4-ff97-4b2e-968b-d36f6a487dd0';

    const {data: existingDestinatario, error} = await supabase
                                        .from("destinatarios")
                                        .select("*")
                                        .eq('name', nombre_destino);
                          
    console.log("Destinatario encontrado:", existingDestinatario);

   if(!existingDestinatario || existingDestinatario.length === 0){
    return {error: "No existe el destinatario."};
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
                                                metodo_pago_id: mercado_pago_id,
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
