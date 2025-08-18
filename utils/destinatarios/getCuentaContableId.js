const supabase = require("../../supabase");
const { getOwnerIdByNameStrict } = require("./getOwnerIdByName");


async function getCuentaContable(ownerId, existingMedioPago) {
  try {
    if (ownerId && typeof ownerId === 'string') {
      if (ownerId) {
        const { data: cuentaLink, error: errCuenta } = await supabase
          .from("metodo_pago_destinatario_duenos")
          .select("id")
          .eq("destinatario_id", ownerId)              
          .eq("metodo_pago_id", existingMedioPago.id) 
          .maybeSingle?.() || { data: null, error: null };

        if (errCuenta) {
          console.log("⚠️ Error consultando cuenta contable:", errCuenta.message || errCuenta);
          return null;
        }
        if (cuentaLink && cuentaLink.id) {
          console.log(`ℹ️ Cuenta contable encontrada: ${cuentaLink.id}`);
          return cuentaLink.id;
        } else {
          // No encontrada: no bloquear el guardado
          console.log(`ℹ️ Cuenta contable no encontrada para: ${medio_pago} de ${cuenta_contable} (guardando sin vínculo)`);
        }
      } else {
        console.log(`ℹ️ Dueño no resuelto para cuenta_contable="${cuenta_contable}" (guardando sin vínculo)`);
      }
    }
  } catch (e) {
    console.log("⚠️ Error resolviendo cuenta contable:", e?.message || String(e));
  }
}
module.exports = getCuentaContable;