const supabase = require('../supabase');


async function getAllAliasesGroupByDestinatario() {
    try {
       const { data, error } = await supabase.rpc("get_aliases_grouped");

        if (error) {
            console.error("Error al obtener los aliases:", error);
            return [];
        }
        
        return data.map(item => item.alias);
    } catch (error) {
        console.log("error:", error)
        return;
    }
    
}

async function getAliasesForDestinatarios(destinatario, aliases) {
    try {
        const { data, error } = await supabase
            .from("destinatarios")
    
        if (error) {
            console.error("Error al obtener alias:", error);
            return [];
        }
    
        return data.map(item => item.alias);
    } catch (error) {
        
    }
}

getAllAliasesGroupByDestinatario()

module.exports = {
    getAllAliasesGroupByDestinatario,
    getAliasesForDestinatarios
};