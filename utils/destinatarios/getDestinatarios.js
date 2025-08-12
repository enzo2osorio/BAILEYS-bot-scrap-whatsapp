const supabase = require('../../supabase')

async function getDestinatarios () {
    const { data, error } = await supabase.from
                ('destinatarios').select('id, name')
                .order('name', { ascending: true })

    if (error) {
        console.error('Error fetching destinatarios:', error)
        return []
    }
    return data
}

module.exports = {getDestinatarios}